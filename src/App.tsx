import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  LoaderCircle,
  ListTodo,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import {
  getCalendarSelection,
  getTaskListSelection,
  getGoogleSession,
  deleteCalendarEvent,
  listCalendarEvents,
  listGoogleTaskLists,
  listGoogleTasks,
  listGoogleCalendars,
  logoutGoogle,
  saveCalendarEvent,
  saveCalendarSelection,
  saveGoogleTask,
  saveTaskListSelection,
  setGoogleTaskCompleted,
  startGoogleSignIn,
  type CalendarEvent,
  type CalendarEventInput,
  type GoogleCalendar,
  type GoogleTask,
  type GoogleTaskList,
  type GoogleTaskInput,
} from './googleCalendar'

const WEEKS_PER_EXTENSION = 8
const EVENT_POLL_INTERVAL_MS = 60_000

function startOfWeek(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7))
  return result
}

function addDays(date: Date, amount: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + amount)
  return result
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function eventDateKey(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return dateKey(new Date(value))
}

function dayNumber(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 86_400_000
}

function eventEndExclusiveDay(event: CalendarEvent): number {
  const endDay = dayNumber(eventDateKey(event.end))
  if (event.allDay) return endDay

  const end = new Date(event.end)
  const endsAtMidnight = end.getHours() === 0 && end.getMinutes() === 0
    && end.getSeconds() === 0 && end.getMilliseconds() === 0
  return endDay + (endsAtMidnight ? 0 : 1)
}

function isMultiDaySpan(event: CalendarEvent): boolean {
  return eventEndExclusiveDay(event) - dayNumber(eventDateKey(event.start)) > 1
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function localTime(value: string): string {
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatTaskDue(value: string): string {
  const datePart = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0]
  const due = datePart ? new Date(`${datePart}T00:00:00`) : new Date(value)
  return Number.isNaN(due.getTime())
    ? ''
    : `Due ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(due)}`
}

type EventDraft = {
  id?: string
  calendarId: string
  title: string
  allDay: boolean
  startDate: string
  endDate: string
  startTime: string
  endTime: string
  recurringEventId?: string
}

type TaskDraft = {
  id?: string
  taskListId: string
  title: string
  notes: string
  dueDate: string
}

type EventDragState = {
  eventId: string
  targetDayKey: string | null
  pointerX: number
  pointerY: number
}

type ActiveEventDrag = {
  event: CalendarEvent
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
}

function eventTextColor(background: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(background)
  if (!match) return '#202a25'

  const channels = [0, 2, 4].map((index) => {
    const value = Number.parseInt(match[1].slice(index, index + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  const whiteContrast = 1.05 / (luminance + 0.05)
  const darkContrast = (luminance + 0.05) / 0.05
  return whiteContrast > darkContrast ? '#ffffff' : '#202a25'
}

function dayKeyAtPoint(x: number, y: number): string | undefined {
  for (const element of document.elementsFromPoint(x, y)) {
    const dayCell = element.closest<HTMLElement>('[data-day-key]')
    if (dayCell?.dataset.dayKey) return dayCell.dataset.dayKey
  }
  return undefined
}

function App() {
  const [weeks, setWeeks] = useState<Date[]>(() => {
    const monday = startOfWeek(new Date())
    return Array.from({ length: 16 }, (_, index) => addDays(monday, index * 7))
  })
  const [calendars, setCalendars] = useState<GoogleCalendar[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [taskLists, setTaskLists] = useState<GoogleTaskList[]>([])
  const [selectedTaskListIds, setSelectedTaskListIds] = useState<string[]>([])
  const [tasks, setTasks] = useState<GoogleTask[]>([])
  const [taskDraft, setTaskDraft] = useState<TaskDraft | null>(null)
  const [savingTask, setSavingTask] = useState(false)
  const [updatingTaskIds, setUpdatingTaskIds] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null)
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)
  const [eventDrag, setEventDrag] = useState<EventDragState | null>(null)
  const [movingEvent, setMovingEvent] = useState<{ eventId: string; targetDayKey: string } | null>(null)
  const [savingEvent, setSavingEvent] = useState(false)
  const [calendarMenuOpen, setCalendarMenuOpen] = useState(false)
  const [taskListMenuOpen, setTaskListMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [loadingTaskLists, setLoadingTaskLists] = useState(false)
  const [refreshRequest, setRefreshRequest] = useState(0)
  const [taskRefreshRequest, setTaskRefreshRequest] = useState(0)
  const [taskError, setTaskError] = useState('')
  const [error, setError] = useState('')
  const [visibleMonth, setVisibleMonth] = useState(() => new Date())
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  const previousScrollHeight = useRef(0)
  const pendingPrepend = useRef(false)
  const selectionSaveRef = useRef<Promise<void>>(Promise.resolve())
  const taskSelectionSaveRef = useRef<Promise<void>>(Promise.resolve())
  const selectedTaskListIdsRef = useRef<string[]>([])
  const activeEventDragRef = useRef<ActiveEventDrag | null>(null)
  const suppressEventClickRef = useRef<string | null>(null)
  selectedTaskListIdsRef.current = selectedTaskListIds

  const selectedCalendars = useMemo(
    () => calendars.filter(({ id }) => selectedIds.includes(id)),
    [calendars, selectedIds],
  )
  const selectedTaskLists = useMemo(
    () => taskLists.filter(({ id }) => selectedTaskListIds.includes(id)),
    [selectedTaskListIds, taskLists],
  )
  const firstWeek = weeks[0]?.getTime() ?? 0
  const lastWeek = weeks[weeks.length - 1]?.getTime() ?? 0

  useEffect(() => {
    let cancelled = false
    const query = new URLSearchParams(window.location.search)
    const oauthError = query.get('oauthError')
    if (oauthError) {
      const messages: Record<string, string> = {
        google_signin_cancelled: 'Google sign-in was cancelled.',
        google_signin_failed: 'Google sign-in failed. Check the backend configuration and OAuth redirect URI.',
        google_refresh_token_missing: 'Google did not provide a refresh token. Try connecting again and approve the requested access.',
      }
      setError(messages[oauthError] ?? 'Google sign-in failed.')
      query.delete('oauthError')
      const suffix = query.size ? `?${query}` : ''
      window.history.replaceState(null, '', `${window.location.pathname}${suffix}${window.location.hash}`)
    }

    getGoogleSession().then(async (hasSession) => {
      if (!hasSession || cancelled) return
      const [googleCalendars, savedSelection] = await Promise.all([
        listGoogleCalendars(),
        getCalendarSelection(),
      ])
      if (cancelled) return
      setCalendars(googleCalendars)
      const availableIds = new Set(googleCalendars.map(({ id }) => id))
      setSelectedIds(savedSelection.calendarIds === null
        ? googleCalendars.map(({ id }) => id)
        : savedSelection.calendarIds.filter((id) => availableIds.has(id)))
      setEvents([])
      setConnected(true)
    }).catch((sessionError: unknown) => {
      if (!cancelled) setError(sessionError instanceof Error ? sessionError.message : 'Could not restore Google sign-in.')
    })

    const expireSession = () => {
      setConnected(false)
      setCalendars([])
      setSelectedIds([])
      setEvents([])
      setTaskLists([])
      setSelectedTaskListIds([])
      setTasks([])
      setTaskError('')
    }
    window.addEventListener('google-session-expired', expireSession)
    return () => {
      cancelled = true
      window.removeEventListener('google-session-expired', expireSession)
    }
  }, [])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (container && pendingPrepend.current) {
      container.scrollTop += container.scrollHeight - previousScrollHeight.current
      pendingPrepend.current = false
    }
  }, [weeks])

  useEffect(() => {
    const container = scrollRef.current
    const top = topSentinelRef.current
    const bottom = bottomSentinelRef.current
    if (!container || !top || !bottom) return

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        if (entry.target === top) {
          previousScrollHeight.current = container.scrollHeight
          pendingPrepend.current = true
          setWeeks((current) => Array.from({ length: WEEKS_PER_EXTENSION }, (_, index) =>
            addDays(current[0], (index - WEEKS_PER_EXTENSION) * 7),
          ).concat(current))
        } else {
          setWeeks((current) => current.concat(Array.from({ length: WEEKS_PER_EXTENSION }, (_, index) =>
            addDays(current[current.length - 1], (index + 1) * 7),
          )))
        }
      }
    }, { root: container, rootMargin: '360px 0px', threshold: 0 })

    observer.observe(top)
    observer.observe(bottom)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!connected || selectedIds.length === 0) return
    let cancelled = false
    let initialLoad = true
    let pollTimer: number | undefined

    const refreshEvents = async () => {
      if (initialLoad) setLoadingEvents(true)
      try {
        const nextEvents = await listCalendarEvents(
          selectedIds,
          new Date(firstWeek),
          addDays(new Date(lastWeek), 7),
        )
        if (!cancelled) {
          setEvents(nextEvents)
          setError('')
        }
      } catch (requestError: unknown) {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Could not load calendar events.')
      } finally {
        if (!cancelled) {
          setLoadingEvents(false)
          initialLoad = false
          pollTimer = window.setTimeout(() => void refreshEvents(), EVENT_POLL_INTERVAL_MS)
        }
      }
    }

    void refreshEvents()
    return () => {
      cancelled = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    }
  }, [connected, firstWeek, lastWeek, refreshRequest, selectedIds])

  useEffect(() => {
    if (!connected) {
      setTaskLists([])
      setSelectedTaskListIds([])
      setTasks([])
      setTaskError('')
      setLoadingTaskLists(false)
      return
    }

    let cancelled = false
    let pollTimer: number | undefined
    const refreshTaskLists = async (restoreSelection: boolean) => {
      if (restoreSelection) setLoadingTaskLists(true)
      try {
        const availableTaskLists = await listGoogleTaskLists()
        if (cancelled) return
        const availableIds = new Set(availableTaskLists.map(({ id }) => id))
        setTaskLists(availableTaskLists)

        if (restoreSelection) {
          const savedSelection = await getTaskListSelection()
          if (cancelled) return
          setTaskError('')
          const selectedIds = savedSelection.taskListIds === null
            ? availableTaskLists.map(({ id }) => id)
            : savedSelection.taskListIds.filter((id) => availableIds.has(id))
          selectedTaskListIdsRef.current = selectedIds
          setSelectedTaskListIds(selectedIds)
          if (savedSelection.taskListIds !== null && selectedIds.length !== savedSelection.taskListIds.length) {
            taskSelectionSaveRef.current = taskSelectionSaveRef.current
              .catch(() => undefined)
              .then(() => saveTaskListSelection(selectedIds))
              .catch((saveError: unknown) => {
                setTaskError(saveError instanceof Error ? saveError.message : 'Could not update the saved task-list selection.')
              })
          }
        } else {
          const currentIds = selectedTaskListIdsRef.current
          const selectedIds = currentIds.filter((id) => availableIds.has(id))
          if (selectedIds.length !== currentIds.length) {
            selectedTaskListIdsRef.current = selectedIds
            setSelectedTaskListIds(selectedIds)
            taskSelectionSaveRef.current = taskSelectionSaveRef.current
              .catch(() => undefined)
              .then(() => saveTaskListSelection(selectedIds))
              .catch((saveError: unknown) => {
                setTaskError(saveError instanceof Error ? saveError.message : 'Could not update the saved task-list selection.')
              })
          }
        }
      } catch (taskListError: unknown) {
        if (!cancelled) setTaskError(taskListError instanceof Error ? taskListError.message : 'Could not load Google task lists.')
      } finally {
        if (!cancelled) {
          setLoadingTaskLists(false)
          pollTimer = window.setTimeout(() => void refreshTaskLists(false), EVENT_POLL_INTERVAL_MS)
        }
      }
    }

    void refreshTaskLists(true)
    return () => {
      cancelled = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    }
  }, [connected])

  useEffect(() => {
    if (!connected || selectedTaskListIds.length === 0) {
      setTasks([])
      setLoadingTasks(false)
      return
    }

    let cancelled = false
    let initialLoad = true
    let pollTimer: number | undefined
    const refreshTasks = async () => {
      if (initialLoad) setLoadingTasks(true)
      try {
        const nextTasks = await listGoogleTasks(selectedTaskListIds)
        if (!cancelled) {
          setTasks(nextTasks)
          setTaskError('')
        }
      } catch (taskError: unknown) {
        if (!cancelled) setTaskError(taskError instanceof Error ? taskError.message : 'Could not load Google tasks.')
      } finally {
        if (!cancelled) {
          setLoadingTasks(false)
          initialLoad = false
          pollTimer = window.setTimeout(() => void refreshTasks(), EVENT_POLL_INTERVAL_MS)
        }
      }
    }

    void refreshTasks()
    return () => {
      cancelled = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    }
  }, [connected, selectedTaskListIds, taskRefreshRequest])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const updateMonth = () => {
      const currentRow = weeks.find((week) => {
        const element = rowRefs.current.get(week.getTime())
        return element && element.offsetTop + element.offsetHeight > container.scrollTop + 60
      })
      if (currentRow) {
        const days = Array.from({ length: 7 }, (_, index) => addDays(currentRow, index))
        const firstOfMonth = days.find((day) => day.getDate() === 1)
        const lastOfMonth = days.find((day) => day.getDate() === new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate())
        const representativeDay = firstOfMonth ?? lastOfMonth ?? days[3]
        setVisibleMonth(new Date(representativeDay.getFullYear(), representativeDay.getMonth(), 1))
      }
    }
    container.addEventListener('scroll', updateMonth, { passive: true })
    return () => container.removeEventListener('scroll', updateMonth)
  }, [weeks])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      if (!selectedIds.includes(event.calendarId)) continue
      const startKey = eventDateKey(event.start)
      const endKey = eventDateKey(event.end)
      const endIsMidnight = !event.allDay && new Date(event.end).getHours() === 0 && new Date(event.end).getMinutes() === 0
      const lastDay = addDays(new Date(`${endKey}T00:00:00`), event.allDay || endIsMidnight ? -1 : 0)
      for (let day = new Date(`${startKey}T00:00:00`); day <= lastDay; day = addDays(day, 1)) {
        const key = dateKey(day)
        map.set(key, [...(map.get(key) ?? []), event])
      }
    }
    return map
  }, [events, selectedIds])

  const multiDaySpansByWeek = useMemo(() => {
    const spansByWeek = new Map<number, Array<{
      event: CalendarEvent
      startColumn: number
      endColumn: number
      lane: number
    }>>()

    for (const week of weeks) {
      const weekStart = dayNumber(dateKey(week))
      const weekEnd = weekStart + 7
      const segments = events.flatMap((event) => {
        if (!isMultiDaySpan(event) || !selectedIds.includes(event.calendarId)) return []
        const eventStart = dayNumber(eventDateKey(event.start))
        const eventEnd = eventEndExclusiveDay(event)
        if (eventStart >= weekEnd || eventEnd <= weekStart) return []

        return [{
          event,
          startColumn: Math.max(eventStart, weekStart) - weekStart + 1,
          endColumn: Math.min(eventEnd, weekEnd) - weekStart + 1,
          duration: eventEnd - eventStart,
        }]
      }).sort((a, b) => b.duration - a.duration || a.startColumn - b.startColumn || a.endColumn - b.endColumn)

      const laneEndColumns: number[] = []
      const spans = segments.map((segment) => {
        let lane = laneEndColumns.findIndex((endColumn) => endColumn <= segment.startColumn)
        if (lane < 0) lane = laneEndColumns.length
        laneEndColumns[lane] = segment.endColumn
        return { event: segment.event, startColumn: segment.startColumn, endColumn: segment.endColumn, lane }
      })
      spansByWeek.set(week.getTime(), spans)
    }

    return spansByWeek
  }, [events, selectedIds, weeks])

  async function connectGoogle() {
    setError('')
    setBusy(true)
    startGoogleSignIn()
  }

  async function disconnectGoogle() {
    try {
      await logoutGoogle()
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Could not disconnect Google Calendar.')
      return
    }
    setConnected(false)
    setCalendars([])
    setSelectedIds([])
    setEvents([])
    setTaskLists([])
    setSelectedTaskListIds([])
    setTasks([])
    setTaskError('')
    setCalendarMenuOpen(false)
    setTaskListMenuOpen(false)
  }

  function toggleCalendar(id: string) {
    const nextIds = selectedIds.includes(id)
      ? selectedIds.filter((selectedId) => selectedId !== id)
      : [...selectedIds, id]
    setSelectedIds(nextIds)
    if (connected) {
      selectionSaveRef.current = selectionSaveRef.current
        .catch(() => undefined)
        .then(() => saveCalendarSelection(nextIds))
        .catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : 'Could not save calendar selection.')
        })
    }
  }

  function toggleTaskList(id: string) {
    const nextIds = selectedTaskListIds.includes(id)
      ? selectedTaskListIds.filter((selectedId) => selectedId !== id)
      : [...selectedTaskListIds, id]
    setSelectedTaskListIds(nextIds)
    if (connected) {
      taskSelectionSaveRef.current = taskSelectionSaveRef.current
        .catch(() => undefined)
        .then(() => saveTaskListSelection(nextIds))
        .catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : 'Could not save task-list selection.')
        })
    }
  }

  function openNewTask(taskListId: string) {
    setTaskError('')
    setTaskDraft({ taskListId, title: '', notes: '', dueDate: '' })
  }

  function openEditTask(task: GoogleTask) {
    setTaskError('')
    setTaskDraft({
      id: task.id,
      taskListId: task.taskListId,
      title: task.title,
      notes: task.notes ?? '',
      dueDate: /^\d{4}-\d{2}-\d{2}/.exec(task.due ?? '')?.[0] ?? '',
    })
  }

  async function submitTask(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    if (!taskDraft) return
    const input: GoogleTaskInput = {
      id: taskDraft.id,
      taskListId: taskDraft.taskListId,
      title: taskDraft.title.trim(),
      notes: taskDraft.notes.trim(),
      dueDate: taskDraft.dueDate,
    }
    if (!input.title) {
      setTaskError('Enter a task title.')
      return
    }

    setSavingTask(true)
    setTaskError('')
    try {
      await saveGoogleTask(input)
      setTaskDraft(null)
      setTaskRefreshRequest((request) => request + 1)
    } catch (saveError: unknown) {
      setTaskError(saveError instanceof Error ? saveError.message : 'Could not save the task.')
    } finally {
      setSavingTask(false)
    }
  }

  async function toggleTaskCompleted(task: GoogleTask) {
    setUpdatingTaskIds((ids) => [...ids, task.id])
    setTaskError('')
    try {
      await setGoogleTaskCompleted(task, !task.completed)
      setTaskRefreshRequest((request) => request + 1)
    } catch (updateError: unknown) {
      setTaskError(updateError instanceof Error ? updateError.message : 'Could not update the task.')
    } finally {
      setUpdatingTaskIds((ids) => ids.filter((id) => id !== task.id))
    }
  }

  function openNewEvent(day: Date) {
    if (!connected) {
      setError('Connect Google Calendar to create or edit events.')
      return
    }
    if (selectedIds.length === 0) {
      setError('Select a calendar before creating an event.')
      return
    }

    setError('')
    setDeleteConfirmationOpen(false)
    setEventDraft({
      calendarId: selectedIds[0],
      title: '',
      allDay: false,
      startDate: dateKey(day),
      endDate: dateKey(day),
      startTime: '09:00',
      endTime: '10:00',
    })
  }

  function openEditEvent(event: CalendarEvent) {
    if (!connected) {
      setError('Connect Google Calendar to create or edit events.')
      return
    }

    const endDate = event.allDay
      ? dateKey(addDays(new Date(`${eventDateKey(event.end)}T00:00:00`), -1))
      : eventDateKey(event.end)
    setError('')
    setDeleteConfirmationOpen(false)
    setEventDraft({
      id: event.id,
      calendarId: event.calendarId,
      title: event.title,
      allDay: event.allDay,
      startDate: eventDateKey(event.start),
      endDate,
      startTime: event.allDay ? '09:00' : localTime(event.start),
      endTime: event.allDay ? '10:00' : localTime(event.end),
      recurringEventId: event.recurringEventId,
    })
  }

  async function submitEvent(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    if (!eventDraft) return
    if (!eventDraft.startDate || !eventDraft.endDate
      || (!eventDraft.allDay && (!eventDraft.startTime || !eventDraft.endTime))) {
      setError('Enter the event dates and times.')
      return
    }

    const start = eventDraft.allDay
      ? eventDraft.startDate
      : new Date(`${eventDraft.startDate}T${eventDraft.startTime}`).toISOString()
    const end = eventDraft.allDay
      ? dateKey(addDays(new Date(`${eventDraft.endDate}T00:00:00`), 1))
      : new Date(`${eventDraft.endDate}T${eventDraft.endTime}`).toISOString()
    if (eventDraft.allDay ? eventDraft.endDate < eventDraft.startDate : new Date(end) <= new Date(start)) {
      setError(eventDraft.allDay ? 'The end date must be on or after the start date.' : 'The end time must be after the start time.')
      return
    }

    const input: CalendarEventInput = {
      id: eventDraft.id,
      calendarId: eventDraft.calendarId,
      title: eventDraft.title,
      start,
      end,
      allDay: eventDraft.allDay,
    }
    setSavingEvent(true)
    setError('')
    try {
      await saveCalendarEvent(input)
      const nextEvents = await listCalendarEvents(
        selectedIds,
        new Date(firstWeek),
        addDays(new Date(lastWeek), 7),
      )
      setEvents(nextEvents)
      setEventDraft(null)
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the calendar event.')
    } finally {
      setSavingEvent(false)
    }
  }

  async function confirmDeleteEvent(wholeSeries: boolean) {
    if (!eventDraft?.id) return
    setSavingEvent(true)
    setError('')
    try {
      await deleteCalendarEvent(eventDraft.id, eventDraft.calendarId, wholeSeries)
      setEventDraft(null)
      setDeleteConfirmationOpen(false)
      setRefreshRequest((request) => request + 1)
    } catch (deleteError: unknown) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete the calendar event.')
    } finally {
      setSavingEvent(false)
    }
  }

  function beginEventDrag(pointerEvent: ReactPointerEvent<HTMLDivElement>, event: CalendarEvent) {
    if (!connected || isMultiDaySpan(event) || (pointerEvent.pointerType === 'mouse' && pointerEvent.button !== 0)) return
    pointerEvent.stopPropagation()
    activeEventDragRef.current = {
      event,
      pointerId: pointerEvent.pointerId,
      startX: pointerEvent.clientX,
      startY: pointerEvent.clientY,
      dragging: false,
    }
    pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId)
  }

  function updateEventDrag(pointerEvent: ReactPointerEvent<HTMLDivElement>) {
    const activeDrag = activeEventDragRef.current
    if (!activeDrag || activeDrag.pointerId !== pointerEvent.pointerId) return
    pointerEvent.stopPropagation()

    if (!activeDrag.dragging && Math.hypot(pointerEvent.clientX - activeDrag.startX, pointerEvent.clientY - activeDrag.startY) < 8) return
    activeDrag.dragging = true

    setEventDrag({
      eventId: activeDrag.event.id,
      targetDayKey: dayKeyAtPoint(pointerEvent.clientX, pointerEvent.clientY) ?? null,
      pointerX: pointerEvent.clientX,
      pointerY: pointerEvent.clientY,
    })
  }

  function finishEventDrag(pointerEvent: ReactPointerEvent<HTMLDivElement>) {
    const activeDrag = activeEventDragRef.current
    if (!activeDrag || activeDrag.pointerId !== pointerEvent.pointerId) return
    pointerEvent.stopPropagation()

    const targetDayKey = activeDrag.dragging
      ? dayKeyAtPoint(pointerEvent.clientX, pointerEvent.clientY)
      : undefined
    activeEventDragRef.current = null
    setEventDrag(null)

    if (!activeDrag.dragging) return
    suppressEventClickRef.current = activeDrag.event.id
    window.setTimeout(() => {
      if (suppressEventClickRef.current === activeDrag.event.id) suppressEventClickRef.current = null
    }, 500)

    if (targetDayKey && targetDayKey !== eventDateKey(activeDrag.event.start)) {
      void moveSingleDayEvent(activeDrag.event, targetDayKey)
    }
  }

  function cancelEventDrag(pointerEvent: ReactPointerEvent<HTMLDivElement>) {
    const activeDrag = activeEventDragRef.current
    if (!activeDrag || activeDrag.pointerId !== pointerEvent.pointerId) return
    pointerEvent.stopPropagation()
    activeEventDragRef.current = null
    setEventDrag(null)
  }

  async function moveSingleDayEvent(event: CalendarEvent, targetDayKey: string) {
    const dayOffset = dayNumber(targetDayKey) - dayNumber(eventDateKey(event.start))
    if (!dayOffset) return

    const shiftDate = (value: string) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return dateKey(addDays(new Date(`${value}T00:00:00`), dayOffset))
      }
      const shifted = new Date(value)
      shifted.setDate(shifted.getDate() + dayOffset)
      return shifted.toISOString()
    }

    setError('')
    setMovingEvent({ eventId: event.id, targetDayKey })
    setLoadingEvents(true)
    try {
      await saveCalendarEvent({
        id: event.id,
        calendarId: event.calendarId,
        title: event.title,
        start: shiftDate(event.start),
        end: shiftDate(event.end),
        allDay: event.allDay,
      })
      const nextEvents = await listCalendarEvents(
        selectedIds,
        new Date(firstWeek),
        addDays(new Date(lastWeek), 7),
      )
      setEvents(nextEvents)
    } catch (moveError: unknown) {
      setError(moveError instanceof Error ? moveError.message : 'Could not move the calendar event.')
    } finally {
      setLoadingEvents(false)
      setMovingEvent(null)
    }
  }

  function scrollToToday() {
    const today = startOfWeek(new Date()).getTime()
    const row = rowRefs.current.get(today)
    if (row && scrollRef.current) scrollRef.current.scrollTo({ top: row.offsetTop, behavior: 'smooth' })
  }

  function moveMonth(direction: number) {
    const destination = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + direction, 1)
    setVisibleMonth(destination)
    const targetWeek = startOfWeek(destination)
    let target = weeks.find((week) => week.getTime() === targetWeek.getTime())
    if (!target) {
      if (direction < 0) {
        const added = Array.from({ length: WEEKS_PER_EXTENSION }, (_, index) => addDays(weeks[0], (index - WEEKS_PER_EXTENSION) * 7))
        setWeeks((current) => [...added, ...current])
        target = added.find((week) => week.getTime() === targetWeek.getTime())
      } else {
        const added = Array.from({ length: WEEKS_PER_EXTENSION }, (_, index) => addDays(weeks[weeks.length - 1], (index + 1) * 7))
        setWeeks((current) => [...current, ...added])
        target = added.find((week) => week.getTime() === targetWeek.getTime())
      }
    }
    if (target) requestAnimationFrame(() => {
      const row = rowRefs.current.get(target!.getTime())
      if (row && scrollRef.current) scrollRef.current.scrollTo({ top: row.offsetTop, behavior: 'smooth' })
    })
  }

  const draggedEvent = eventDrag
    ? events.find((event) => event.id === eventDrag.eventId)
    : undefined

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Infinite Calendar home">
          <span className="brand-mark"><CalendarDays size={20} strokeWidth={2.2} /></span>
          <span>daybook<span className="brand-period">.</span></span>
        </a>
        <div className="topbar-actions">
          <span className={`connection-status ${connected ? 'is-connected' : ''}`}>
            <span className="status-dot" />{connected ? 'Google Calendar connected' : 'Not connected'}
          </span>
          {connected ? (
            <button className="button button-outline" onClick={() => void disconnectGoogle()}>Disconnect</button>
          ) : (
            <button className="button button-dark" onClick={connectGoogle} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              Connect Google
            </button>
          )}
        </div>
      </header>

      <section className="calendar-area" id="top">
        <div className="calendar-toolbar">
          <div className="month-navigation">
            <h1>{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(visibleMonth)}</h1>
            <div className="nav-buttons">
              <button className="icon-button" aria-label="Previous month" title="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={18} /></button>
              <button className="icon-button" aria-label="Next month" title="Next month" onClick={() => moveMonth(1)}><ChevronRight size={18} /></button>
            </div>
          </div>
          <div className="toolbar-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh calendar"
              title="Refresh calendar"
              disabled={!connected || loadingEvents || selectedIds.length === 0}
              onClick={() => setRefreshRequest((request) => request + 1)}
            >
              {loadingEvents ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}
            </button>
            <button className="button button-outline today-button" onClick={scrollToToday}>Today</button>
            <div className="calendar-picker-wrap">
              <button className="button button-outline calendar-picker" onClick={() => setCalendarMenuOpen((open) => !open)} aria-expanded={calendarMenuOpen}>
                <span className="calendar-stack">{selectedCalendars.slice(0, 3).map((calendar) => <i key={calendar.id} style={{ backgroundColor: calendar.backgroundColor }} />)}</span>
                Calendars <span className="selection-count">{selectedCalendars.length}</span><ChevronDown size={15} />
              </button>
              {calendarMenuOpen && (
                <div className="calendar-menu">
                  <div className="menu-heading">Show calendars</div>
                  {calendars.map((calendar) => (
                    <button className="calendar-option" key={calendar.id} onClick={() => toggleCalendar(calendar.id)}>
                      <span className="calendar-color" style={{ backgroundColor: calendar.backgroundColor }} />
                      <span className="calendar-name">{calendar.summary}</span>
                      <span className={`checkmark ${selectedIds.includes(calendar.id) ? 'checked' : ''}`}>{selectedIds.includes(calendar.id) && <Check size={13} />}</span>
                    </button>
                  ))}
                  <button className="menu-settings" onClick={() => { setCalendarMenuOpen(false); setSettingsOpen(true) }}><Settings2 size={15} /> Calendar settings</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="weekday-header" aria-hidden="true">
          {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((day) => <span key={day}>{day}</span>)}
        </div>

        <div className="week-scroll" ref={scrollRef}>
          <div className="scroll-sentinel" ref={topSentinelRef} />
          {weeks.map((week) => {
            const weekKey = week.getTime()
            const multiDaySpans = multiDaySpansByWeek.get(weekKey) ?? []
            return (
              <section className="week-row" key={weekKey} ref={(element) => {
                if (element) rowRefs.current.set(weekKey, element)
                else rowRefs.current.delete(weekKey)
              }} aria-label={`Week of ${new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(week)}`}>
                {Array.from({ length: 7 }, (_, index) => {
                  const day = addDays(week, index)
                  const dayColumn = index + 1
                  const dayLaneCount = multiDaySpans.reduce(
                    (count, span) => span.startColumn <= dayColumn && span.endColumn > dayColumn
                      ? Math.max(count, span.lane + 1)
                      : count,
                    0,
                  )
                  const dayEvents = eventsByDay.get(dateKey(day)) ?? []
                  const visibleDayEvents = dayEvents.filter((event) => !isMultiDaySpan(event))
                  const today = dateKey(day) === dateKey(new Date())
                  const pastDay = dateKey(day) < dateKey(new Date())
                  const outsideMonth = day.getMonth() !== visibleMonth.getMonth() || day.getFullYear() !== visibleMonth.getFullYear()
                  const monthTone = day.getMonth() % 2 === 0 ? 'month-tone-a' : 'month-tone-b'
                  const weekend = day.getDay() === 0 || day.getDay() === 6
                  return (
                    <div
                      className={`day-cell ${monthTone} ${weekend ? 'is-weekend' : ''} ${pastDay ? 'is-past' : ''} ${today ? 'is-today' : ''} ${outsideMonth ? 'outside-month' : ''} ${eventDrag?.targetDayKey === dateKey(day) ? 'is-drop-target' : ''} ${movingEvent?.targetDayKey === dateKey(day) ? 'is-moving-target' : ''}`}
                      key={dateKey(day)}
                      data-day-key={dateKey(day)}
                      onClick={() => {
                        if (suppressEventClickRef.current) {
                          suppressEventClickRef.current = null
                          return
                        }
                        openNewEvent(day)
                      }}
                    >
                      <div className="day-label">
                        <span className="day-number">{new Intl.DateTimeFormat(undefined, { day: '2-digit' }).format(day)}</span>
                        {day.getDate() === 1 && (
                          <>
                            <span className="month-name month-name-full">{new Intl.DateTimeFormat(undefined, { month: 'long' }).format(day)}</span>
                            <span className="month-name month-name-short">{new Intl.DateTimeFormat(undefined, { month: 'short' }).format(day)}</span>
                          </>
                        )}
                        {today && <i>Today</i>}
                      </div>
                      {movingEvent?.targetDayKey === dateKey(day) && (
                        <div className="event-move-indicator" role="status">
                          <LoaderCircle className="spin" size={14} />
                          <span>Moving event</span>
                        </div>
                      )}
                      <div className="day-events" style={{ marginTop: `calc(${dayLaneCount} * var(--all-day-lane-height))` }}>
                        {visibleDayEvents.slice(0, 4).map((event) => (
                          <div
                            className={`event ${connected ? 'is-draggable' : ''} ${eventDrag?.eventId === event.id ? 'is-dragging' : ''}`}
                            key={event.id}
                            title={`${event.title}${event.allDay ? '' : ` · ${formatTime(event.start)}`}`}
                            style={{ backgroundColor: event.color, color: eventTextColor(event.color) }}
                            role="button"
                            tabIndex={0}
                            onClick={(clickEvent) => {
                              clickEvent.stopPropagation()
                              if (suppressEventClickRef.current === event.id) {
                                suppressEventClickRef.current = null
                                return
                              }
                              openEditEvent(event)
                            }}
                            onPointerDown={(pointerEvent) => beginEventDrag(pointerEvent, event)}
                            onPointerMove={updateEventDrag}
                            onPointerUp={finishEventDrag}
                            onPointerCancel={cancelEventDrag}
                            onKeyDown={(keyEvent) => {
                              if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                                keyEvent.preventDefault()
                                openEditEvent(event)
                              }
                            }}
                          >
                            <span className="event-dot" style={{ backgroundColor: event.color }} />
                            {!event.allDay && <span className="event-time">{formatTime(event.start)}</span>}
                            <span className="event-title">{event.title}</span>
                          </div>
                        ))}
                        {visibleDayEvents.length > 4 && (
                          <span className="more-events" onClick={(clickEvent) => clickEvent.stopPropagation()}>
                            +{visibleDayEvents.length - 4} more
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
                {multiDaySpans.map(({ event, startColumn, endColumn, lane }) => (
                  <div
                    className={`event multi-day-span ${event.allDay ? 'all-day-span' : 'timed-span'}`}
                    key={event.id}
                    title={`${event.title}${event.allDay ? '' : ` · ${formatTime(event.start)}–${formatTime(event.end)}`}`}
                    role="button"
                    tabIndex={0}
                    onClick={(clickEvent) => { clickEvent.stopPropagation(); openEditEvent(event) }}
                    onKeyDown={(keyEvent) => {
                      if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                        keyEvent.preventDefault()
                        openEditEvent(event)
                      }
                    }}
                    style={{
                      backgroundColor: event.color,
                      color: eventTextColor(event.color),
                      left: `calc(${((startColumn - 1) / 7) * 100}% + var(--day-cell-side-padding))`,
                      width: `calc(${((endColumn - startColumn) / 7) * 100}% - var(--day-cell-side-padding) - var(--day-cell-side-padding))`,
                      top: `calc(var(--day-cell-top) + var(--day-label-height) + ${lane} * var(--all-day-lane-height))`,
                    }}
                  >
                    <span className="event-dot" style={{ backgroundColor: event.color }} />
                    {!event.allDay && startColumn === dayNumber(eventDateKey(event.start)) - dayNumber(dateKey(week)) + 1
                      && <span className="event-time">{formatTime(event.start)}</span>}
                    <span className="event-title">{event.title}</span>
                    {!event.allDay && eventEndExclusiveDay(event) <= dayNumber(dateKey(week)) + 7
                      && <span className="event-time event-end-time">{formatTime(event.end)}</span>}
                  </div>
                ))}
              </section>
            )
          })}
          <div className="scroll-sentinel bottom-sentinel" ref={bottomSentinelRef} />
          {loadingEvents && !movingEvent && (
            <div className="loading-indicator" role="status">
              <LoaderCircle className="spin" size={15} />
              Updating events
            </div>
          )}
        </div>

        <footer className="calendar-footer">
          <span>{connected ? `${selectedCalendars.length} calendars synced` : 'Connect Google Calendar to see your events'}</span>
          <button className="footer-help" onClick={() => setSettingsOpen(true)}><CircleHelp size={15} /> Setup</button>
        </footer>
      </section>

      <section className="tasks-panel" aria-labelledby="tasks-heading">
        <div className="tasks-panel-header">
          <div className="tasks-heading">
            <ListTodo size={18} />
            <h2 id="tasks-heading">Google Tasks</h2>
          </div>
          <div className="tasks-panel-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh tasks"
              title="Refresh tasks"
              disabled={!connected || loadingTasks || selectedTaskListIds.length === 0}
              onClick={() => setTaskRefreshRequest((request) => request + 1)}
            >
              {loadingTasks ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
            </button>
            <div className="task-list-picker-wrap">
              <button
                className="button button-outline task-list-picker"
                type="button"
                aria-expanded={taskListMenuOpen}
                onClick={() => setTaskListMenuOpen((open) => !open)}
                disabled={!connected || loadingTaskLists || taskLists.length === 0}
              >
                Task lists <span className="selection-count">{selectedTaskListIds.length}</span>
                <ChevronDown size={15} />
              </button>
              {taskListMenuOpen && (
                <div className="task-list-menu">
                  <div className="menu-heading">Show task lists</div>
                  {taskLists.map((taskList) => (
                    <button
                      className="calendar-option"
                      type="button"
                      key={taskList.id}
                      onClick={() => toggleTaskList(taskList.id)}
                    >
                      <span className="calendar-name">{taskList.title}</span>
                      <span className={`checkmark ${selectedTaskListIds.includes(taskList.id) ? 'checked' : ''}`}>
                        {selectedTaskListIds.includes(taskList.id) && <Check size={13} />}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="tasks-panel-content">
          {!connected ? (
            <p className="tasks-empty">Connect Google Calendar to see your Google Tasks.</p>
          ) : taskError ? (
            <p className="tasks-empty task-error" role="alert">{taskError}</p>
          ) : loadingTaskLists && taskLists.length === 0 ? (
            <p className="tasks-empty"><LoaderCircle className="spin" size={15} /> Loading task lists…</p>
          ) : taskLists.length === 0 ? (
            <p className="tasks-empty">No Google task lists found.</p>
          ) : selectedTaskLists.length === 0 ? (
            <p className="tasks-empty">Choose task lists to display.</p>
          ) : loadingTasks && tasks.length === 0 ? (
            <p className="tasks-empty"><LoaderCircle className="spin" size={15} /> Loading tasks…</p>
          ) : (
            <div className="task-list-columns">
              {selectedTaskLists.map((taskList) => {
                const listTasks = tasks.filter((task) => task.taskListId === taskList.id)
                const activeTasks = listTasks.filter((task) => !task.completed)
                const completedTasks = listTasks.filter((task) => task.completed)
                const renderTask = (task: GoogleTask) => (
                  <li className={task.completed ? 'is-completed' : ''} key={task.id}>
                    <button
                      className="task-status-mark"
                      type="button"
                      disabled={updatingTaskIds.includes(task.id)}
                      aria-label={task.completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
                      title={task.completed ? 'Reopen task' : 'Complete task'}
                      onClick={() => void toggleTaskCompleted(task)}
                    >
                      {updatingTaskIds.includes(task.id)
                        ? <LoaderCircle className="spin" size={12} />
                        : task.completed ? <Check size={12} /> : null}
                    </button>
                    <div className="task-copy">
                      <button className="task-title-button" type="button" onClick={() => openEditTask(task)}>
                        <span className="task-title">{task.title}</span>
                      </button>
                      {task.notes && <span className="task-notes">{task.notes}</span>}
                      {task.due && <span className="task-due">{formatTaskDue(task.due)}</span>}
                    </div>
                  </li>
                )
                return (
                  <section className="task-list-column" key={taskList.id} aria-label={taskList.title}>
                    <div className="task-list-title-row">
                      <h3>{taskList.title}</h3>
                      <button
                        className="task-add-button"
                        type="button"
                        onClick={() => openNewTask(taskList.id)}
                        aria-label={`Add task to ${taskList.title}`}
                        title="Add task"
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                    {listTasks.length === 0 ? (
                      <p className="task-list-empty">No tasks</p>
                    ) : (
                      <div className="task-list-items">
                        {activeTasks.length > 0 && <ul>{activeTasks.map(renderTask)}</ul>}
                        {completedTasks.length > 0 && (
                          <details className="completed-task-section">
                            <summary>
                              <span>Completed</span>
                              <span className="completed-task-count">{completedTasks.length}</span>
                              <ChevronDown size={14} />
                            </summary>
                            <ul>{completedTasks.map(renderTask)}</ul>
                          </details>
                        )}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {taskDraft && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingTask) setTaskDraft(null)
          }}
        >
          <form
            className="settings-dialog task-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-editor-title"
            onSubmit={(formEvent) => void submitTask(formEvent)}
          >
            <div className="dialog-heading">
              <div>
                <span className="eyebrow">{taskLists.find(({ id }) => id === taskDraft.taskListId)?.title ?? 'GOOGLE TASKS'}</span>
                <h2 id="task-editor-title">{taskDraft.id ? 'Edit task' : 'New task'}</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setTaskDraft(null)} aria-label="Close task editor" disabled={savingTask}>
                <X size={18} />
              </button>
            </div>
            {taskError && <p className="dialog-error" role="alert">{taskError}</p>}
            <label className="field-label" htmlFor="task-title">Task</label>
            <input
              id="task-title"
              className="text-input"
              value={taskDraft.title}
              onChange={(changeEvent) => setTaskDraft((current) => current ? { ...current, title: changeEvent.target.value } : current)}
              maxLength={1024}
              required
              autoFocus
            />
            <label className="field-label task-notes-label" htmlFor="task-notes">Notes</label>
            <textarea
              id="task-notes"
              className="text-input task-notes-input"
              value={taskDraft.notes}
              onChange={(changeEvent) => setTaskDraft((current) => current ? { ...current, notes: changeEvent.target.value } : current)}
              maxLength={8192}
              rows={3}
            />
            <label className="field-label task-due-label" htmlFor="task-due-date">Due date</label>
            <input
              id="task-due-date"
              className="text-input"
              type="date"
              value={taskDraft.dueDate}
              onChange={(changeEvent) => setTaskDraft((current) => current ? { ...current, dueDate: changeEvent.target.value } : current)}
            />
            <div className="dialog-actions">
              <button className="button button-outline" type="button" onClick={() => setTaskDraft(null)} disabled={savingTask}>Cancel</button>
              <button className="button button-dark" type="submit" disabled={savingTask}>
                {savingTask ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                {taskDraft.id ? 'Save changes' : 'Create task'}
              </button>
            </div>
          </form>
        </div>
      )}

      {eventDrag && draggedEvent && (
        <div
          className="event-drag-ghost"
          aria-hidden="true"
          style={{
            backgroundColor: draggedEvent.color,
            color: eventTextColor(draggedEvent.color),
            left: Math.max(16, Math.min(eventDrag.pointerX + 14, window.innerWidth - Math.min(260, window.innerWidth - 32) - 16)),
            top: eventDrag.pointerY + 14,
            width: 'min(260px, calc(100vw - 32px))',
          }}
        >
          <span className="event-dot" style={{ backgroundColor: draggedEvent.color }} />
          {!draggedEvent.allDay && <span className="event-time">{formatTime(draggedEvent.start)}</span>}
          <span className="event-title">{draggedEvent.title}</span>
        </div>
      )}

      {error && !eventDraft && (
        <div className="toast-error" role="alert">
          <span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="dialog-heading">
              <div><span className="eyebrow">YOUR CALENDAR</span><h2 id="settings-title">Connect Google</h2></div>
              <button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button>
            </div>
            <p className="dialog-copy">Connect securely through the calendar backend. Google refresh tokens stay on the server and are never stored in this browser.</p>
            <div className="setup-note"><Clock3 size={16} /><span>The backend needs a Google OAuth Web application client ID and secret. Add this site's origin and <code>{window.location.origin}/auth/callback</code> as an authorized redirect URI.</span></div>
            <a className="console-link" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Open Google Cloud credentials <ExternalLink size={14} /></a>
            <div className="dialog-actions">
              <button className="button button-outline" onClick={() => setSettingsOpen(false)}>Cancel</button>
              <button className="button button-dark" onClick={() => { setSettingsOpen(false); void connectGoogle() }} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <CalendarDays size={16} />} Connect calendar
              </button>
            </div>
          </section>
        </div>
      )}

      {eventDraft && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingEvent) { setEventDraft(null); setDeleteConfirmationOpen(false) } }}>
          <form className="settings-dialog event-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="event-editor-title" onSubmit={(formEvent) => void submitEvent(formEvent)}>
            <div className="dialog-heading">
              <div><span className="eyebrow">YOUR CALENDAR</span><h2 id="event-editor-title">{deleteConfirmationOpen ? 'Delete event?' : eventDraft.id ? 'Edit event' : 'New event'}</h2></div>
              <button className="icon-button" type="button" onClick={() => { setEventDraft(null); setDeleteConfirmationOpen(false) }} aria-label="Close event editor" disabled={savingEvent}><X size={18} /></button>
            </div>
            {error && <p className="dialog-error" role="alert">{error}</p>}
            {deleteConfirmationOpen ? (
              <>
                <p className="dialog-copy">
                  {eventDraft.recurringEventId
                    ? 'This event is part of a recurring series. Choose whether to delete only this occurrence or the entire series.'
                    : 'This will permanently delete this event from Google Calendar.'}
                </p>
                <div className="dialog-actions">
                  <button className="button button-outline" type="button" onClick={() => setDeleteConfirmationOpen(false)} disabled={savingEvent}>Cancel</button>
                  {eventDraft.recurringEventId ? (
                    <>
                      <button className="button button-danger" type="button" onClick={() => void confirmDeleteEvent(false)} disabled={savingEvent}>Just this event</button>
                      <button className="button button-danger" type="button" onClick={() => void confirmDeleteEvent(true)} disabled={savingEvent}>Entire series</button>
                    </>
                  ) : (
                    <button className="button button-danger" type="button" onClick={() => void confirmDeleteEvent(false)} disabled={savingEvent}>
                      {savingEvent && <LoaderCircle className="spin" size={16} />} Delete event
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
            <label className="field-label" htmlFor="event-title">Event name</label>
            <input
              id="event-title"
              className="text-input"
              value={eventDraft.title}
              onChange={(changeEvent) => setEventDraft((current) => current ? { ...current, title: changeEvent.target.value } : current)}
              maxLength={500}
              required
              autoFocus
            />
            <label className="field-label event-field-label" htmlFor="event-calendar">Calendar</label>
            <select
              id="event-calendar"
              className="text-input"
              value={eventDraft.calendarId}
              disabled={Boolean(eventDraft.id)}
              onChange={(changeEvent) => setEventDraft((current) => current ? { ...current, calendarId: changeEvent.target.value } : current)}
            >
              {selectedCalendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.summary}</option>)}
            </select>
            <label className="all-day-toggle">
              <input
                type="checkbox"
                checked={eventDraft.allDay}
                onChange={(changeEvent) => setEventDraft((current) => current ? { ...current, allDay: changeEvent.target.checked } : current)}
              />
              All-day event
            </label>
            <div className={`event-date-fields ${eventDraft.allDay ? '' : 'has-times'}`}>
              <label className="field-label" htmlFor="event-start-date">Start date</label>
              <input
                id="event-start-date"
                className="text-input"
                type="date"
                value={eventDraft.startDate}
                required
                onChange={(changeEvent) => setEventDraft((current) => current ? { ...current, startDate: changeEvent.target.value } : current)}
              />
              {!eventDraft.allDay && (
                <>
                  <label className="field-label" htmlFor="event-start-time">Start time</label>
                  <input
                    id="event-start-time"
                    className="text-input"
                    type="time"
                    value={eventDraft.startTime}
                    required
                    onChange={(changeEvent) => setEventDraft((current) => current ? { ...current, startTime: changeEvent.target.value } : current)}
                  />
                </>
              )}
              <label className="field-label" htmlFor="event-end-date">{eventDraft.allDay ? 'End date (inclusive)' : 'End date'}</label>
              <input
                id="event-end-date"
                className="text-input"
                type="date"
                value={eventDraft.endDate}
                required
                onChange={(changeEvent) => setEventDraft((current) => current ? { ...current, endDate: changeEvent.target.value } : current)}
              />
              {!eventDraft.allDay && (
                <>
                  <label className="field-label" htmlFor="event-end-time">End time</label>
                  <input
                    id="event-end-time"
                    className="text-input"
                    type="time"
                    value={eventDraft.endTime}
                    required
                    onChange={(changeEvent) => setEventDraft((current) => current ? { ...current, endTime: changeEvent.target.value } : current)}
                  />
                </>
              )}
            </div>
            <div className="dialog-actions">
              {eventDraft.id && (
                <button className="button button-danger" type="button" onClick={() => { setError(''); setDeleteConfirmationOpen(true) }} disabled={savingEvent}>
                  <Trash2 size={16} /> Delete
                </button>
              )}
              <button className="button button-outline" type="button" onClick={() => setEventDraft(null)} disabled={savingEvent}>Cancel</button>
              <button className="button button-dark" type="submit" disabled={savingEvent}>
                {savingEvent ? <LoaderCircle className="spin" size={16} /> : <CalendarDays size={16} />}
                {eventDraft.id ? 'Save changes' : 'Create event'}
              </button>
            </div>
              </>
            )}
          </form>
        </div>
      )}
    </main>
  )
}

export default App