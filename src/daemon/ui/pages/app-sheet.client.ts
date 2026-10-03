// Shared native-dialog dismissal: keyboard, backdrop and a downward pull.
// Native dialogs contain focus and restore it to their opener when closed.
export const APP_SHEET_SCRIPT = `
window.AXSheet = function (sheet, onClose) {
  var handle = document.createElement('button');
  handle.type = 'button'; handle.className = 'sheet-handle';
  handle.setAttribute('aria-label', 'Close sheet');
  sheet.insertBefore(handle, sheet.firstChild);
  function close() { sheet.close('cancel'); }
  handle.addEventListener('click', function (ev) { if (distance > 5) { ev.preventDefault(); distance = 0; return; } close(); });
  sheet.addEventListener('click', function (ev) {
    if (ev.target !== sheet) return;
    var r = sheet.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) close();
  });
  var start = null, distance = 0;
  handle.addEventListener('pointerdown', function (ev) {
    if (ev.button > 0) return;
    start = ev.clientY; distance = 0;
    handle.setPointerCapture(ev.pointerId);
  });
  handle.addEventListener('pointermove', function (ev) {
    if (start == null) return;
    distance = Math.max(0, ev.clientY - start);
    sheet.style.transform = 'translateY(' + distance + 'px)';
  });
  function reset() { start = null; sheet.style.transform = ''; }
  handle.addEventListener('pointerup', function () { var dismiss = distance > 90; reset(); if (dismiss) close(); });
  handle.addEventListener('pointercancel', reset);
  sheet.addEventListener('close', function () { reset(); if (onClose) onClose(); });
};
`
