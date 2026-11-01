(function () {
  const scroller=document.getElementById('requisition-builder-scroll');
  if(!scroller) return;
  // Let the page reach the table header before consuming wheel input inside the table.
  scroller.addEventListener('wheel',event=>{
    if(window.matchMedia('(max-width: 600px)').matches || event.ctrlKey || event.shiftKey || event.deltaY<=0 || Math.abs(event.deltaX)>Math.abs(event.deltaY)) return;
    const top=scroller.getBoundingClientRect().top;
    if(top<=1) return;
    const available=document.documentElement.scrollHeight-window.innerHeight-window.scrollY;
    if(available<=1) return;
    const delta=event.deltaMode===1?event.deltaY*16:event.deltaMode===2?event.deltaY*window.innerHeight:event.deltaY;
    event.preventDefault();
    window.scrollBy({top:Math.min(delta,top,available),behavior:'instant'});
  },{passive:false});
}());
