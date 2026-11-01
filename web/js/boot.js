// Classic script that runs even when ES modules are blocked by the browser's
// file:// policy. It turns the blank-ish page into a clear instruction instead
// of showing a dead form.
(function () {
  if (window.location.protocol !== 'file:') return;
  document.addEventListener('DOMContentLoaded', function () {
    var error = document.getElementById('boot-error');
    var init = document.getElementById('init-screen');
    var app = document.getElementById('app-screen');
    if (error) error.hidden = false;
    if (init) init.hidden = true;
    if (app) app.hidden = true;
  });
}());
