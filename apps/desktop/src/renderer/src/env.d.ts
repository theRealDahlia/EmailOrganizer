/// <reference types="vite/client" />
import type { OrganizerApi } from "../../shared"

declare global {
  interface Window {
    organizer: OrganizerApi
  }
}
