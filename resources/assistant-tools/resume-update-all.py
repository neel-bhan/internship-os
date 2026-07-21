#!/usr/bin/env python3
"""Apply exact shared replacements to job-specific drafts for every configured profile."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


CLI = Path(__file__).with_name("internship-os")


class BatchError(RuntimeError):
    pass


def run_cli(*args: str) -> Any:
    process = subprocess.run(
        [str(CLI), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        detail = process.stderr.strip() or process.stdout.strip()
        raise BatchError(f"Command failed: {' '.join(args)}: {detail}")
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise BatchError(
            f"Command returned invalid JSON: {' '.join(args)}"
        ) from error


def discover_profiles() -> tuple[str, ...]:
    payload = run_cli("resume", "profiles")
    if not isinstance(payload, list) or not payload:
        raise BatchError("No configured resume profiles were returned.")
    profile_ids: list[str] = []
    for item in payload:
        profile_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(profile_id, str) or not profile_id:
            raise BatchError("A configured resume profile is missing its ID.")
        profile_ids.append(profile_id)
    return tuple(profile_ids)


def load_replacements(spec_path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BatchError(f"Could not read replacement spec: {error}") from error

    replacements = payload.get("replacements")
    if not isinstance(replacements, list) or not replacements:
        raise BatchError("Spec must contain a non-empty 'replacements' list.")

    normalized: list[dict[str, Any]] = []
    for index, replacement in enumerate(replacements, start=1):
        if not isinstance(replacement, dict):
            raise BatchError(f"Replacement {index} must be an object.")
        old = replacement.get("old")
        new = replacement.get("new")
        expected = replacement.get("expected", 1)
        if not isinstance(old, str) or not old:
            raise BatchError(f"Replacement {index} needs a non-empty 'old' string.")
        if not isinstance(new, str):
            raise BatchError(f"Replacement {index} needs a string 'new' value.")
        if not isinstance(expected, int) or expected < 1:
            raise BatchError(f"Replacement {index} needs a positive integer 'expected'.")
        normalized.append({"old": old, "new": new, "expected": expected})
    return normalized


def transform_source(
    profile: str, source: str, replacements: list[dict[str, Any]]
) -> str:
    updated = source
    for index, replacement in enumerate(replacements, start=1):
        old = replacement["old"]
        count = updated.count(old)
        expected = replacement["expected"]
        if count != expected:
            raise BatchError(
                f"{profile}: replacement {index} matched {count} times; expected {expected}."
            )
        updated = updated.replace(old, replacement["new"])
    return updated


def restore_selections(
    active_profile: str,
    active_drafts: dict[str, str | None],
) -> list[str]:
    errors: list[str] = []
    for profile, draft_name in active_drafts.items():
        try:
            run_cli("resume", "select", "--profile", profile)
            if draft_name:
                run_cli(
                    "resume",
                    "draft-select",
                    "--name",
                    draft_name,
                    "--profile",
                    profile,
                )
            else:
                run_cli("resume", "draft-stop", "--profile", profile)
        except BatchError as error:
            errors.append(str(error))
    try:
        run_cli("resume", "select", "--profile", active_profile)
        active_draft = active_drafts.get(active_profile)
        if active_draft:
            run_cli(
                "resume",
                "draft-select",
                "--name",
                active_draft,
                "--profile",
                active_profile,
            )
    except BatchError as error:
        errors.append(str(error))
    return errors


def rollback_profiles(profiles: list[tuple[str, str]]) -> list[str]:
    errors: list[str] = []
    for profile, draft_name in reversed(profiles):
        try:
            run_cli("resume", "select", "--profile", profile)
            run_cli(
                "resume",
                "draft-select",
                "--name",
                draft_name,
                "--profile",
                profile,
            )
            run_cli("resume", "undo")
        except BatchError as error:
            errors.append(str(error))
    return errors


def remove_created_drafts(drafts: list[tuple[str, str]]) -> list[str]:
    errors: list[str] = []
    for profile, draft_name in reversed(drafts):
        try:
            run_cli("resume", "select", "--profile", profile)
            run_cli("resume", "draft-stop", "--profile", profile)
            run_cli(
                "resume",
                "draft-delete",
                "--name",
                draft_name,
                "--profile",
                profile,
            )
        except BatchError as error:
            errors.append(str(error))
    return errors


def remove_candidates(
    candidates: dict[str, tuple[Path, str, str | None]],
) -> list[str]:
    errors: list[str] = []
    for profile, (candidate_path, _, _) in candidates.items():
        try:
            candidate_path.unlink(missing_ok=True)
        except OSError as error:
            errors.append(f"{profile}: could not remove prepared candidate: {error}")
    return errors


def select_working_draft(
    profile: str,
    initial_draft: str | None,
    draft_name: str,
    dry_run: bool,
) -> tuple[str | None, bool]:
    run_cli("resume", "select", "--profile", profile)
    if initial_draft:
        run_cli(
            "resume",
            "draft-select",
            "--name",
            initial_draft,
            "--profile",
            profile,
        )
        return initial_draft, False
    if dry_run:
        run_cli("resume", "draft-stop", "--profile", profile)
        return None, False
    created = run_cli(
        "resume",
        "draft-create",
        "--name",
        draft_name,
        "--profile",
        profile,
    )
    job_draft = created.get("jobDraft") if isinstance(created, dict) else {}
    created_name = job_draft.get("name") if isinstance(job_draft, dict) else None
    if not isinstance(created_name, str) or not created_name:
        created_name = draft_name
    return created_name, True


def update_all(spec_path: Path, dry_run: bool, draft_name: str) -> dict[str, Any]:
    profiles = discover_profiles()
    replacements = load_replacements(spec_path)
    initial_state = run_cli("resume", "state")
    active_profile = initial_state.get("activeProfileId")
    if active_profile not in profiles:
        raise BatchError("Could not determine the active resume profile.")

    active_drafts: dict[str, str | None] = {}
    for profile in profiles:
        draft_state = run_cli("resume", "draft-list", "--profile", profile)
        active_drafts[profile] = (
            draft_state.get("name") if draft_state.get("active") else None
        )

    candidates: dict[str, tuple[Path, str, str | None]] = {}
    completed: list[tuple[str, str]] = []
    created_drafts: list[tuple[str, str]] = []
    results: list[dict[str, Any]] = []
    failed = False

    try:
        # Validate every configured profile before writing or promoting any candidate.
        for profile in profiles:
            working_draft, created = select_working_draft(
                profile,
                active_drafts[profile],
                draft_name,
                dry_run,
            )
            if created and working_draft:
                created_drafts.append((profile, working_draft))
            prepared = run_cli("resume", "prepare")
            candidate_value = prepared.get("candidatePath")
            if not isinstance(candidate_value, str) or not candidate_value:
                raise BatchError(f"{profile}: prepare did not return a candidate path.")
            candidate_path = Path(candidate_value)
            try:
                source = candidate_path.read_text(encoding="utf-8")
            except OSError as error:
                raise BatchError(f"{profile}: could not read candidate: {error}") from error
            candidates[profile] = (
                candidate_path,
                transform_source(profile, source, replacements),
                working_draft,
            )

        if dry_run:
            return {
                "ok": True,
                "dryRun": True,
                "profilesValidated": list(profiles),
                "replacementsValidated": len(replacements),
            }

        for candidate_path, source, _ in candidates.values():
            candidate_path.write_text(source, encoding="utf-8")

        for profile in profiles:
            candidate_path, _, working_draft = candidates[profile]
            if not working_draft:
                raise BatchError(f"{profile}: no job-specific draft was selected.")
            run_cli("resume", "select", "--profile", profile)
            run_cli(
                "resume",
                "draft-select",
                "--name",
                working_draft,
                "--profile",
                profile,
            )
            promoted = run_cli("resume", "promote", "--path", str(candidate_path))
            compile_result = promoted.get("lastCompile") or {}
            compile_ok = compile_result.get("ok") is True
            pages = compile_result.get("pages")
            if not compile_ok:
                raise BatchError(
                    f"{profile}: promotion validation failed "
                    f"(compiled={compile_ok}, pages={pages})."
                )
            completed.append((profile, working_draft))
            results.append(
                {
                    "profile": profile,
                    "draft": working_draft,
                    "compiled": True,
                    "pages": pages,
                }
            )

        return {
            "ok": True,
            "profiles": results,
            "verification": {
                "profilesUpdated": len(results),
                "allCompiled": len(results) == len(profiles),
                "pageCounts": {
                    result["profile"]: result["pages"] for result in results
                },
            },
        }
    except Exception as error:
        failed = True
        rollback_errors = rollback_profiles(completed)
        batch_error = error if isinstance(error, BatchError) else BatchError(str(error))
        setattr(batch_error, "rollback_errors", rollback_errors)
        raise batch_error
    finally:
        candidate_cleanup_errors = (
            remove_candidates(candidates) if dry_run or failed else []
        )
        cleanup_errors = remove_created_drafts(created_drafts) if failed else []
        restore_errors = restore_selections(active_profile, active_drafts)
        warnings = candidate_cleanup_errors + cleanup_errors + restore_errors
        if warnings:
            print(json.dumps({"selectionRestoreWarnings": warnings}), file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Apply exact replacements to job-specific drafts for every configured "
            "resume, compile each, report page counts, and return one consolidated "
            "verification report."
        )
    )
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument(
        "--draft-name",
        default="Shared Resume Update",
        help="Draft name to create for profiles that do not already have an active draft.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate all replacements without modifying or promoting candidates.",
    )
    args = parser.parse_args()

    try:
        report = update_all(
            args.spec.expanduser().resolve(),
            args.dry_run,
            args.draft_name,
        )
    except BatchError as error:
        report: dict[str, Any] = {"ok": False, "error": str(error)}
        rollback_errors = getattr(error, "rollback_errors", [])
        if rollback_errors:
            report["rollbackErrors"] = rollback_errors
        print(json.dumps(report, indent=2))
        return 1

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
