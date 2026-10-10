/**
 * Which input device the `me` channel should open.
 *
 * Opening a Bluetooth headset as the microphone drops it into the hands-free
 * profile (HFP): playback and capture both collapse to telephone-grade audio
 * (24 kHz or less on AirPods), and the system-audio tap on that same headset
 * then delivers a mangled stream that transcribes as gibberish. Opening the
 * built-in microphone instead keeps the headset in A2DP for playback, so the
 * interviewer's audio stays clean. Your own voice is picked up by the Mac.
 *
 * Detection is name-based: device names are the only transport signal the
 * native module exposes. Ported from terapia's microphoneRouting.ts.
 */
export interface AudioDeviceSummary {
  id: string;
  name: string;
}

export interface MicRoutingDecision {
  /** Device id to open, or `null` for the platform default microphone. */
  deviceId: string | null;
  deviceName: string | null;
  reason: 'default' | 'avoid_bluetooth_hfp' | 'bluetooth_output_no_builtin_mic';
  outputName: string;
}

const BLUETOOTH_FAMILIES = [
  'airpods', 'beats', 'bose', 'sony wh', 'sony wf', 'wh-1000', 'wf-1000',
  'jabra', 'galaxy buds', 'pixel buds', 'soundcore', 'jbl', 'sennheiser',
  'momentum', 'oneplus', 'one plus', 'buds', 'earbuds', 'earbud', 'tws',
  'bluetooth',
];

const BUILT_IN_INPUT = /macbook|built[- ]?in|imac|mac\s+studio|mac\s+mini|internal|microphone array/i;

export function normalizeDeviceName(name: string): string {
  return (name || '')
    .replace(/:(input|output)$/i, '')
    .replace(/[–—−]/g, '-')
    .trim()
    .toLowerCase();
}

export function isBluetoothDeviceName(name: string): boolean {
  const n = normalizeDeviceName(name);
  if (!n) return false;
  if (n.includes('hands-free') || n.includes('handsfree') || n.includes('(hfp')) return true;
  return BLUETOOTH_FAMILIES.some((family) => n.includes(family));
}

export function findBuiltInInput(inputs: readonly AudioDeviceSummary[]): AudioDeviceSummary | undefined {
  return inputs.find((d) => BUILT_IN_INPUT.test(d.name));
}

export function resolveOutputName(outputs: readonly AudioDeviceSummary[], outputId: string): string {
  if (!outputId) return '';
  const wanted = normalizeDeviceName(outputId);
  return outputs.find((d) => normalizeDeviceName(d.id) === wanted)?.name ?? '';
}

export function chooseMicrophoneDevice(input: {
  inputs: readonly AudioDeviceSummary[];
  outputs: readonly AudioDeviceSummary[];
  defaultOutputId: string;
}): MicRoutingDecision {
  const outputName = resolveOutputName(input.outputs, input.defaultOutputId);
  if (!isBluetoothDeviceName(outputName)) {
    return { deviceId: null, deviceName: null, reason: 'default', outputName };
  }
  const builtIn = findBuiltInInput(input.inputs);
  if (!builtIn) {
    return { deviceId: null, deviceName: null, reason: 'bluetooth_output_no_builtin_mic', outputName };
  }
  return { deviceId: builtIn.id, deviceName: builtIn.name, reason: 'avoid_bluetooth_hfp', outputName };
}
