export type GoogleCalendar = {
  id: string
  summary: string
  backgroundColor?: string
  primary?: boolean
}

export type GoogleTaskList = {
  id: string
  title: string
}

export type GoogleTask = {
  id: string
  taskListId: string
  title: string
  notes?: string
  due?: string
  completed: boolean
}

export type GoogleTaskInput = {
  id?: string
  taskListId: string
  title: string
  notes: string
  dueDate: string
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
  if (response.status === 404) {
    throw new Error(`The backend does not recognize ${path}. Restart the backend to load the latest API endpoints.`)
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

export function listGoogleTaskLists(): Promise<GoogleTaskList[]> {
  return apiRequest<GoogleTaskList[]>('/api/tasklists')
}

export function getTaskListSelection(): Promise<{ taskListIds: string[] | null }> {
  return apiRequest<{ taskListIds: string[] | null }>('/api/tasklist-selection')
}

export function saveTaskListSelection(taskListIds: string[]): Promise<void> {
  return apiRequest<void>('/api/tasklist-selection', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskListIds }),
  })
}

export function listGoogleTasks(taskListIds: string[]): Promise<GoogleTask[]> {
  if (taskListIds.length === 0) return Promise.resolve([])
  const query = new URLSearchParams()
  taskListIds.forEach((id) => query.append('taskListIds', id))
  return apiRequest<GoogleTask[]>(`/api/tasks?${query}`)
}

export function saveGoogleTask(task: GoogleTaskInput): Promise<void> {
  const isUpdate = Boolean(task.id)
  return apiRequest<void>(`/api/tasks/${isUpdate ? 'update' : 'create'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  })
}

export function setGoogleTaskCompleted(task: GoogleTask, completed: boolean): Promise<void> {
  return apiRequest<void>('/api/tasks/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskListId: task.taskListId,
      taskId: task.id,
      completed,
    }),
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
