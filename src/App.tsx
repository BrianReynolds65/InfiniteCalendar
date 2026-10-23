import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
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
  Plus,
  Settings2,
  X,
} from 'lucide-react'
import {
  getCalendarSelection,
  getGoogleSession,
  listCalendarEvents,
  listGoogleCalendars,
  logoutGoogle,
  saveCalendarEvent,
  saveCalendarSelection,
  startGoogleSignIn,
  type CalendarEvent,
  type CalendarEventInput,
  type GoogleCalendar,
} from './googleCalendar'

const WEEKS_PER_EXTENSION = 8
const EVENT_POLL_INTERVAL_MS = 60_000
const DEMO_CALENDARS: GoogleCalendar[] = [
  { id: 'demo-work', summary: 'Studio', backgroundColor: '#18866b', primary: true },
  { id: 'demo-personal', summary: 'Personal', backgroundColor: '#e8795d' },
  { id: 'demo-family', summary: 'Family', backgroundColor: '#6978ca' },
]

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

type EventDraft = {
  id?: string
  calendarId: string
  title: string
  allDay: boolean
  startDate: string
  endDate: string
  startTime: string
  endTime: string
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

function demoEvents(): CalendarEvent[] {
  const today = new Date()
  const monday = startOfWeek(today)
  const items: Array<[number, number, string, string, number]> = [
    [0, 9, 'Weekly studio sync', 'demo-work', 1],
    [0, 14, 'Project: Fieldnotes', 'demo-work', 1],
    [1, 11, 'Design review', 'demo-work', 1],
    [1, 18, 'Dinner with Maya', 'demo-personal', 2],
    [2, 8, 'School drop-off', 'demo-family', 1],
    [2, 13, 'Focus block', 'demo-work', 2],
    [3, 10, 'Product critique', 'demo-work', 1],
    [3, 16, 'Dentist', 'demo-personal', 1],
    [4, 9, 'Planning & priorities', 'demo-work', 1],
    [4, 19, 'Movie night', 'demo-family', 2],
    [5, 10, 'Farmers market', 'demo-personal', 3],
    [6, 12, 'Sunday lunch', 'demo-family', 2],
  ]
  return items.map(([day, hour, title, calendarId, duration], index) => {
    const start = addDays(monday, day)
    start.setHours(hour, 0, 0, 0)
    const end = new Date(start.getTime() + duration * 60 * 60 * 1000)
    const calendar = DEMO_CALENDARS.find((item) => item.id === calendarId)!
    return {
      id: `demo-${index}`,
      calendarId,
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: false,
      color: calendar.backgroundColor!,
    }
  })
}

function App() {
  const [weeks, setWeeks] = useState<Date[]>(() => {
    const monday = startOfWeek(new Date())
    return Array.from({ length: 16 }, (_, index) => addDays(monday, index * 7))
  })
  const [calendars, setCalendars] = useState<GoogleCalendar[]>(DEMO_CALENDARS)
  const [selectedIds, setSelectedIds] = useState<string[]>(DEMO_CALENDARS.map(({ id }) => id))
  const [events, setEvents] = useState<CalendarEvent[]>(demoEvents)
  const [connected, setConnected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null)
  const [savingEvent, setSavingEvent] = useState(false)
  const [calendarMenuOpen, setCalendarMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [error, setError] = useState('')
  const [visibleMonth, setVisibleMonth] = useState(() => new Date())
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  const previousScrollHeight = useRef(0)
  const pendingPrepend = useRef(false)
  const selectionSaveRef = useRef<Promise<void>>(Promise.resolve())

  const selectedCalendars = useMemo(
    () => calendars.filter(({ id }) => selectedIds.includes(id)),
    [calendars, selectedIds],
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
      setCalendars(DEMO_CALENDARS)
      setSelectedIds(DEMO_CALENDARS.map(({ id }) => id))
      setEvents(demoEvents())
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
          if (initialLoad) {
            setLoadingEvents(false)
            initialLoad = false
          }
          pollTimer = window.setTimeout(() => void refreshEvents(), EVENT_POLL_INTERVAL_MS)
        }
      }
    }

    void refreshEvents()
    return () => {
      cancelled = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    }
  }, [connected, firstWeek, lastWeek, selectedIds])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const updateMonth = () => {
      const currentRow = weeks.find((week) => {
        const element = rowRefs.current.get(week.getTime())
        return element && element.offsetTop + element.offsetHeight > container.scrollTop + 60
      })
      if (currentRow) setVisibleMonth(currentRow)
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
    setCalendars(DEMO_CALENDARS)
    setSelectedIds(DEMO_CALENDARS.map(({ id }) => id))
    setEvents(demoEvents())
    setCalendarMenuOpen(false)
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
    setEventDraft({
      id: event.id,
      calendarId: event.calendarId,
      title: event.title,
      allDay: event.allDay,
      startDate: eventDateKey(event.start),
      endDate,
      startTime: event.allDay ? '09:00' : localTime(event.start),
      endTime: event.allDay ? '10:00' : localTime(event.end),
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

  function scrollToToday() {
    const today = startOfWeek(new Date()).getTime()
    const row = rowRefs.current.get(today)
    if (row && scrollRef.current) scrollRef.current.scrollTo({ top: row.offsetTop, behavior: 'smooth' })
  }

  function moveMonth(direction: number) {
    const destination = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + direction, 1)
    let target = weeks.find((week) => week.getMonth() === destination.getMonth() && week.getFullYear() === destination.getFullYear())
    if (!target) {
      if (direction < 0) {
        const added = Array.from({ length: WEEKS_PER_EXTENSION }, (_, index) => addDays(weeks[0], (index - WEEKS_PER_EXTENSION) * 7))
        setWeeks((current) => [...added, ...current])
        target = added.find((week) => week.getMonth() === destination.getMonth() && week.getFullYear() === destination.getFullYear())
      } else {
        const added = Array.from({ length: WEEKS_PER_EXTENSION }, (_, index) => addDays(weeks[weeks.length - 1], (index + 1) * 7))
        setWeeks((current) => [...current, ...added])
        target = added.find((week) => week.getMonth() === destination.getMonth() && week.getFullYear() === destination.getFullYear())
      }
    }
    if (target) requestAnimationFrame(() => {
      const row = rowRefs.current.get(target!.getTime())
      if (row && scrollRef.current) scrollRef.current.scrollTo({ top: row.offsetTop, behavior: 'smooth' })
    })
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Infinite Calendar home">
          <span className="brand-mark"><CalendarDays size={20} strokeWidth={2.2} /></span>
          <span>daybook<span className="brand-period">.</span></span>
        </a>
        <div className="topbar-actions">
          <span className={`connection-status ${connected ? 'is-connected' : ''}`}>
            <span className="status-dot" />{connected ? 'Google Calendar connected' : 'Preview calendar'}
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
            const multiDayLaneCount = multiDaySpans.reduce((count, span) => Math.max(count, span.lane + 1), 0)
            return (
              <section className="week-row" key={weekKey} ref={(element) => {
                if (element) rowRefs.current.set(weekKey, element)
                else rowRefs.current.delete(weekKey)
              }} aria-label={`Week of ${new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(week)}`}>
                {Array.from({ length: 7 }, (_, index) => {
                  const day = addDays(week, index)
                  const dayEvents = eventsByDay.get(dateKey(day)) ?? []
                  const visibleDayEvents = dayEvents.filter((event) => !isMultiDaySpan(event))
                  const today = dateKey(day) === dateKey(new Date())
                  const outsideMonth = day.getMonth() !== visibleMonth.getMonth() || day.getFullYear() !== visibleMonth.getFullYear()
                  const monthTone = day.getMonth() % 2 === 0 ? 'month-tone-a' : 'month-tone-b'
                  const weekend = day.getDay() === 0 || day.getDay() === 6
                  return (
                    <div
                      className={`day-cell ${monthTone} ${weekend ? 'is-weekend' : ''} ${today ? 'is-today' : ''} ${outsideMonth ? 'outside-month' : ''}`}
                      key={dateKey(day)}
                      onClick={() => openNewEvent(day)}
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
                      <div className="day-events" style={{ marginTop: `calc(${multiDayLaneCount} * var(--all-day-lane-height))` }}>
                        {visibleDayEvents.slice(0, 4).map((event) => (
                          <div
                            className="event"
                            key={event.id}
                            title={`${event.title}${event.allDay ? '' : ` · ${formatTime(event.start)}`}`}
                            style={{ backgroundColor: event.color, color: eventTextColor(event.color) }}
                            role="button"
                            tabIndex={0}
                            onClick={(clickEvent) => { clickEvent.stopPropagation(); openEditEvent(event) }}
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
                    onClick={() => openEditEvent(event)}
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
          {loadingEvents && <div className="loading-indicator"><LoaderCircle className="spin" size={15} /> Updating events</div>}
        </div>

        <footer className="calendar-footer">
          <span>{connected ? `${selectedCalendars.length} calendars synced` : 'Sample week · connect Google to see your calendar'}</span>
          <button className="footer-help" onClick={() => setSettingsOpen(true)}><CircleHelp size={15} /> Setup</button>
        </footer>
      </section>

      {error && (
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
            <div className="setup-note"><Clock3 size={16} /><span>The backend needs a Google OAuth Web application client ID and secret. Add the Vite origin and <code>http://localhost:5173/auth/callback</code> as an authorized redirect URI.</span></div>
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
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingEvent) setEventDraft(null) }}>
          <form className="settings-dialog event-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="event-editor-title" onSubmit={(formEvent) => void submitEvent(formEvent)}>
            <div className="dialog-heading">
              <div><span className="eyebrow">YOUR CALENDAR</span><h2 id="event-editor-title">{eventDraft.id ? 'Edit event' : 'New event'}</h2></div>
              <button className="icon-button" type="button" onClick={() => setEventDraft(null)} aria-label="Close event editor" disabled={savingEvent}><X size={18} /></button>
            </div>
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
              <button className="button button-outline" type="button" onClick={() => setEventDraft(null)} disabled={savingEvent}>Cancel</button>
              <button className="button button-dark" type="submit" disabled={savingEvent}>
                {savingEvent ? <LoaderCircle className="spin" size={16} /> : <CalendarDays size={16} />}
                {eventDraft.id ? 'Save changes' : 'Create event'}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}

export default App