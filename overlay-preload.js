// overlay-preload.js — bridge ระหว่าง main process และ overlay.html
// contextIsolation: true → ต้องใช้ contextBridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // รับ hover-zone event จาก main
  onHoverZone: (callback) => {
    ipcRenderer.on('hover-zone', (event, active) => callback(active));
  },
  // ส่ง change-url ไป main
  changeUrl: () => {
    ipcRenderer.send('change-url');
  },
});
