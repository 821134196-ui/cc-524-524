// 轻量交互：危险操作确认 + 时间线全部展开/收起
document.addEventListener('submit', (e) => {
  const form = e.target;
  const msg = form.getAttribute('data-confirm')
    || (e.submitter && e.submitter.getAttribute('data-confirm'));
  if (msg && !window.confirm(msg)) e.preventDefault();
});
