/**
 * Bridges the sandboxed renderer to main. Everything the panel can do goes
 * through this surface, and nothing else is exposed.
 *
 * The Supabase client, the project key and the access token all stay in the
 * main process. The renderer only ever sees plain campaign data.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('questHud', {
  loadState: () => ipcRenderer.invoke('state:load'),
  signIn: () => ipcRenderer.invoke('auth:signIn'),
  signOut: () => ipcRenderer.invoke('auth:signOut'),
  setActiveCampaign: id => ipcRenderer.invoke('campaign:setActive', id),
  mutate: action => ipcRenderer.invoke('data:mutate', action),
  joinCampaign: code => ipcRenderer.invoke('campaign:join', code),
  fitWindow: height => ipcRenderer.send('window:fit', height),
  hide: () => ipcRenderer.send('window:hide'),
  copy: text => ipcRenderer.send('clipboard:write', text),
  onStateChanged: callback => ipcRenderer.on('state:changed', (event, state) => callback(state)),
  onRealtimeStatus: callback => ipcRenderer.on('realtime:status', (event, status) => callback(status))
})
