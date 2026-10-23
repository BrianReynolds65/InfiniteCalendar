export type GoogleCalendar = {
  id: string
  summary: string
  backgroundColor?: string
  primary?: boolean
}

export type CalendarEvent = {
  id: string
  calendarId: string
  title: string
  start: string
  end: string
  allDay: boolean
  color: string
  location?: string
  recurringEventId?: string
}

export type CalendarEventInput = {
  id?: string
  calendarId: string
  title: string
  start: string
  end: string
  allDay: boolean
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...options?.headers },
  })
  if (response.status === 401) {
    window.dispatchEvent(new Event('google-session-expired'))
    throw new Error('Google authorization expired. Please connect again.')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; detail?: string; title?: string }
    throw new Error(body.error ?? body.detail ?? body.title ?? `Calendar request failed (${response.status}).`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function getGoogleSession(): Promise<boolean> {
  const response = await fetch('/api/session', { credentials: 'same-origin' })
  if (response.status === 401) return false
  if (!response.ok) throw new Error(`Could not check Google sign-in (${response.status}).`)
  return true
}

export function startGoogleSignIn(): void {
  window.location.assign('/auth/google')
}

export function logoutGoogle(): Promise<void> {
  return apiRequest<void>('/auth/logout', { method: 'POST' })
}

export function listGoogleCalendars(): Promise<GoogleCalendar[]> {
  return apiRequest<GoogleCalendar[]>('/api/calendars')
}

export function getCalendarSelection(): Promise<{ calendarIds: string[] | null }> {
  return apiRequest<{ calendarIds: string[] | null }>('/api/calendar-selection')
}

export function saveCalendarSelection(calendarIds: string[]): Promise<void> {
  return apiRequest<void>('/api/calendar-selection', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarIds }),
  })
}

export function listCalendarEvents(
  calendarIds: string[],
  timeMin: Date,
  timeMax: Date,
): Promise<CalendarEvent[]> {
  const query = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
  })
  calendarIds.forEach((id) => query.append('calendarIds', id))
  return apiRequest<CalendarEvent[]>(`/api/events?${query}`)
}

export function saveCalendarEvent(event: CalendarEventInput): Promise<void> {
  return apiRequest<void>('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
}

export function deleteCalendarEvent(
  eventId: string,
  calendarId: string,
  wholeSeries: boolean,
): Promise<void> {
  return apiRequest<void>('/api/events/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, calendarId, wholeSeries }),
  })
}
