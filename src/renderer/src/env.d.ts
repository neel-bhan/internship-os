/// <reference types="vite/client" />

import type { InternshipOsApi } from '../../shared/types'

declare global {
  interface Window {
    internshipOS: InternshipOsApi
  }
}

export {}
