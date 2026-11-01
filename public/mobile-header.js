(function () {
  const menu=document.querySelector('.app-menu');
  if(!menu) return;
  const smallScreen=window.matchMedia('(max-width: 900px)');
  function adapt() { menu.open=!smallScreen.matches; }
  adapt();
  smallScreen.addEventListener('change',adapt);
}());
