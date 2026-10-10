// audio-defaults: tiny CoreAudio HAL helper used by the app.
//
//   audio-defaults status              -> JSON with default output/input, their
//                                         nominal sample rate and transport, and
//                                         the list of input devices
//   audio-defaults set-input <name|uid> -> make that device the system default
//                                         input; prints JSON {ok, previous}
//
// Why: a Bluetooth headset in hands-free mode (HFP) runs at 8-24 kHz while
// the process tap still reports 48 kHz, so system audio comes out mangled.
// The nominal sample rate is the only reliable signal, and the native module
// does not expose it. Compiled by scripts/build-helper.js (swiftc).
import Foundation
import CoreAudio

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    return AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func getUInt32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var addr = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

func getFloat64(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Double? {
    var addr = address(selector)
    var value: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

func getString(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &value) { ptr in
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
    }
    guard status == noErr else { return nil }
    return value as String
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
    var addr = address(selector)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
    return id
}

func allDevices() -> [AudioDeviceID] {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &addr, 0, nil, &size) == noErr else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func channelCount(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func transportName(_ code: UInt32?) -> String {
    guard let code = code else { return "unknown" }
    switch code {
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeBuiltIn: return "builtin"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeHDMI: return "hdmi"
    case kAudioDeviceTransportTypeDisplayPort: return "displayport"
    case kAudioDeviceTransportTypeAirPlay: return "airplay"
    case kAudioDeviceTransportTypeVirtual: return "virtual"
    case kAudioDeviceTransportTypeAggregate: return "aggregate"
    case kAudioDeviceTransportTypeContinuityCaptureWired, kAudioDeviceTransportTypeContinuityCaptureWireless: return "continuity"
    default: return "other"
    }
}

/// Rate of the first stream's physical format in `scope`. During HFP the
/// device nominal rate can keep saying 48 kHz while the stream really runs
/// at 16-24 kHz, so this is the number that exposes hands-free mode.
func physicalRate(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Double {
    var addr = address(kAudioDevicePropertyStreams, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let count = Int(size) / MemoryLayout<AudioStreamID>.size
    var streams = [AudioStreamID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &streams) == noErr, let first = streams.first else { return 0 }
    var fmtAddr = address(kAudioStreamPropertyPhysicalFormat)
    var fmt = AudioStreamBasicDescription()
    var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioObjectGetPropertyData(first, &fmtAddr, 0, nil, &fmtSize, &fmt) == noErr else { return 0 }
    return fmt.mSampleRate
}

func describe(_ id: AudioDeviceID) -> [String: Any] {
    let nominal = getFloat64(id, kAudioDevicePropertyNominalSampleRate) ?? 0
    let actual = getFloat64(id, kAudioDevicePropertyActualSampleRate) ?? 0
    let outPhys = physicalRate(id, kAudioObjectPropertyScopeOutput)
    let inPhys = physicalRate(id, kAudioObjectPropertyScopeInput)
    // The lowest live rate is the honest one.
    let live = [nominal, actual, outPhys, inPhys].filter { $0 > 0 }.min() ?? 0
    return [
        "id": Int(id),
        "name": getString(id, kAudioObjectPropertyName) ?? "",
        "uid": getString(id, kAudioDevicePropertyDeviceUID) ?? "",
        "sampleRate": live,
        "nominalSampleRate": nominal,
        "actualSampleRate": actual,
        "physicalOutputRate": outPhys,
        "physicalInputRate": inPhys,
        "transport": transportName(getUInt32(id, kAudioDevicePropertyTransportType)),
        "inputChannels": channelCount(id, kAudioObjectPropertyScopeInput),
        "outputChannels": channelCount(id, kAudioObjectPropertyScopeOutput),
    ]
}

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []), let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"error\":\"json\"}")
    }
}

func status() {
    var out: [String: Any] = [:]
    if let o = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) { out["output"] = describe(o) }
    if let i = defaultDevice(kAudioHardwarePropertyDefaultInputDevice) { out["input"] = describe(i) }
    out["inputs"] = allDevices().filter { channelCount($0, kAudioObjectPropertyScopeInput) > 0 }.map(describe)
    out["outputs"] = allDevices().filter { channelCount($0, kAudioObjectPropertyScopeOutput) > 0 }.map(describe)
    emit(out)
}

func setInput(_ wanted: String) {
    let previous = defaultDevice(kAudioHardwarePropertyDefaultInputDevice).map(describe)
    let lowered = wanted.lowercased()
    let match = allDevices().first { id in
        channelCount(id, kAudioObjectPropertyScopeInput) > 0 &&
        ((getString(id, kAudioObjectPropertyName) ?? "").lowercased() == lowered ||
         (getString(id, kAudioDevicePropertyDeviceUID) ?? "").lowercased() == lowered)
    }
    guard var id = match else {
        emit(["ok": false, "error": "input device not found: \(wanted)"])
        exit(2)
    }
    var addr = address(kAudioHardwarePropertyDefaultInputDevice)
    let size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectSetPropertyData(systemObject, &addr, 0, nil, size, &id)
    if status == noErr {
        emit(["ok": true, "previous": previous ?? NSNull(), "current": describe(id)])
    } else {
        emit(["ok": false, "error": "AudioObjectSetPropertyData failed: \(status)"])
        exit(3)
    }
}

let args = CommandLine.arguments.dropFirst()
switch args.first {
case "status", nil:
    status()
case "set-input":
    guard args.count >= 2 else { emit(["ok": false, "error": "usage: set-input <name|uid>"]); exit(1) }
    setInput(args.dropFirst().joined(separator: " "))
default:
    emit(["ok": false, "error": "unknown command"])
    exit(1)
}
