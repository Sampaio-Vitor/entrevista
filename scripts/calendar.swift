// Calendar helper for Entrevista. Reads the local EventKit store, which
// aggregates every account added to macOS (Google, iCloud, Exchange...).
// Built by scripts/build-helper.js into native/EntrevistaCalendar.app: a real
// bundle so macOS shows the calendar permission prompt for it (a bare binary
// is denied without a prompt). Run through `open` by electron/calendar.ts.
//
//   EntrevistaCalendar events --out <file> [--back-hours N] [--ahead-hours N] [--request]
//
// Writes {"access": "...", "events": [...]} to <file>. Without --request an
// undecided permission is reported as "notDetermined" instead of prompting.
import EventKit
import Foundation

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
guard let outPath = arg("--out") else {
  FileHandle.standardError.write("usage: EntrevistaCalendar events --out <file> [--back-hours N] [--ahead-hours N] [--request]\n".data(using: .utf8)!)
  exit(2)
}
let backHours = Double(arg("--back-hours") ?? "") ?? 2
let aheadHours = Double(arg("--ahead-hours") ?? "") ?? 36
let request = args.contains("--request")

func write(_ obj: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  FileManager.default.createFile(atPath: outPath, contents: data)
}

func accessName(_ s: EKAuthorizationStatus) -> String {
  switch s {
  case .fullAccess: return "granted"
  case .writeOnly: return "writeOnly"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

let store = EKEventStore()
var status = EKEventStore.authorizationStatus(for: .event)
if status == .notDetermined && request {
  let sem = DispatchSemaphore(value: 0)
  store.requestFullAccessToEvents { _, _ in sem.signal() }
  sem.wait()
  status = EKEventStore.authorizationStatus(for: .event)
}
guard status == .fullAccess else {
  write(["access": accessName(status), "events": []])
  exit(0)
}

// Video-call links, in the order they are tried. Trailing punctuation from
// prose ("...link).") is stripped afterwards.
let linkPattern = try! NSRegularExpression(
  pattern: "https?://[^\\s<>\"']*(?:zoom\\.us/(?:j|my|w|s)/|meet\\.google\\.com/[a-z]|teams\\.microsoft\\.com/l/meetup-join|teams\\.live\\.com/meet|webex\\.com/|whereby\\.com/|chime\\.aws/)[^\\s<>\"']*",
  options: [.caseInsensitive])

func meetingLink(_ e: EKEvent) -> String? {
  for text in [e.url?.absoluteString, e.location, e.notes].compactMap({ $0 }) {
    let range = NSRange(text.startIndex..., in: text)
    if let m = linkPattern.firstMatch(in: text, range: range), let r = Range(m.range, in: text) {
      return String(text[r]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:)]>"))
    }
  }
  return nil
}

func email(_ p: EKParticipant) -> String? {
  let s = p.url.absoluteString
  return s.lowercased().hasPrefix("mailto:") ? String(s.dropFirst(7)) : nil
}

func hex(_ c: CGColor?) -> String? {
  guard let c, let rgb = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
        let comps = rgb.components, comps.count >= 3 else { return nil }
  return String(format: "#%02x%02x%02x", Int(comps[0] * 255), Int(comps[1] * 255), Int(comps[2] * 255))
}

let now = Date()
let start = now.addingTimeInterval(-backHours * 3600)
let end = now.addingTimeInterval(aheadHours * 3600)
let found = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))

var events: [[String: Any]] = []
for e in found {
  if e.isAllDay || e.status == .canceled { continue }
  let me = e.attendees?.first(where: { $0.isCurrentUser })
  if me?.participantStatus == .declined { continue }
  let attendees: [[String: Any]] = (e.attendees ?? []).compactMap { p in
    if p.participantType == .room || p.participantType == .resource { return nil }
    var a: [String: Any] = ["me": p.isCurrentUser]
    if let n = p.name, !n.isEmpty { a["name"] = n }
    if let m = email(p) { a["email"] = m }
    return a
  }
  var ev: [String: Any] = [
    "id": e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? UUID().uuidString,
    "title": e.title ?? "",
    "start": Int(e.startDate.timeIntervalSince1970 * 1000),
    "end": Int(e.endDate.timeIntervalSince1970 * 1000),
    "calendar": e.calendar.title,
    "source": e.calendar.source.title,
    "attendees": attendees,
  ]
  if let c = hex(e.calendar.cgColor) { ev["color"] = c }
  if let l = meetingLink(e) { ev["link"] = l }
  if let o = e.organizer { ev["organizer"] = o.name ?? email(o) ?? "" }
  events.append(ev)
}
write(["access": "granted", "events": events])
