import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const INVOKE_CHANNELS = new Set([
  'state:get',
  'setup:chat',
  'setup:reset',
  'session:start',
  'session:stop',
  'transcript:clear',
  'answer:ask',
  'code:ask',
  'lang:toggle',
  'window:toggle',
  'window:opacity',
  'sessions:list',
  'sessions:load',
  'sessions:delete',
  'sessions:reveal',
  'sessions:search',
  'sessions:people',
  'participants:rename',
  'meeting:chat',
  'meeting:summarize',
  'meeting:refine',
  'permissions:request',
  'open:external',
  'calendar:upcoming',
]);

const EVENT_CHANNELS = new Set([
  'phase',
  'status',
  'level',
  'transcript',
  'participants',
  'job',
  'answer:start',
  'answer:delta',
  'answer:done',
  'answer:error',
  'answer:queued',
  'setup:briefing',
  'opacity',
  'toast',
]);

contextBridge.exposeInMainWorld('api', {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel: string, handler: (data: unknown) => void): () => void {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`blocked channel ${channel}`);
    const wrapped = (_event: IpcRendererEvent, data: unknown) => handler(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
