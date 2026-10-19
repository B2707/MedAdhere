// Shared opening for the chat GIF and launch video. Every frame comes from render(t).
window.createLockScreen = screen => {
  const messages = screen.querySelector('.messages');
  const lock = document.createElement('div');
  lock.className = 'lock-screen';
  lock.innerHTML = `
    <div class="lock-clock">
      <svg class="lock-padlock" width="19" height="24" viewBox="0 0 19 24"><path d="M4 10V6a5.5 5.5 0 0 1 11 0v4" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="1" y="9" width="17" height="14" rx="4" fill="currentColor"/></svg>
      <div class="lock-date">Monday, October 19</div><div class="lock-time">9:00</div>
    </div>
    <div class="notification">
      <div class="notification-icon"><svg width="27" height="25" viewBox="0 0 22 20"><path d="M11 1C5.5 1 1 4.6 1 9c0 2.4 1.3 4.6 3.4 6L3.5 19l4.3-2.4c1 .3 2.1.4 3.2.4 5.5 0 10-3.6 10-8S16.5 1 11 1z" fill="#fff"/></svg></div>
      <div class="notification-body"><div class="notification-app">MESSAGES<span>now</span></div>
        <div class="notification-name">MedAdhere</div><div class="notification-text"></div></div>
    </div>
    <div class="lock-tools">
      <span><svg width="20" height="25" viewBox="0 0 20 25"><path d="M5 2h10v6l-3 4v10H8V12L5 8z" fill="currentColor"/><path d="M5 5h10" stroke="#34546a" stroke-width="2"/></svg></span>
      <span><svg width="25" height="22" viewBox="0 0 25 22"><path d="M2 5h5l2-3h7l2 3h5v15H2z" fill="currentColor"/><circle cx="12.5" cy="12" r="4.5" fill="#34546a"/></svg></span>
    </div>
    <div class="lock-hint">Swipe up to unlock</div><div class="home"></div>
    <div class="touch-ring"></div><div class="touch"></div>`;
  lock.prepend(messages.querySelector('.status').cloneNode(true));
  lock.querySelector('.notification-text').textContent = messages.querySelector('.b.in').textContent;
  screen.appendChild(lock);
  const card = lock.querySelector('.notification');
  const touch = lock.querySelector('.touch'), ring = lock.querySelector('.touch-ring');
  const clamp = p => Math.max(0, Math.min(1, p));
  const ease = p => { p = clamp(p); return 1 - Math.pow(1 - p, 3); };
  const tapAt = 2.6, end = 3.2;
  return {
    end,
    render(t) {
      const arrived = ease((t - .45) / .55);
      const opening = ease((t - tapAt - .12) / (end - tapAt - .12));
      lock.style.visibility = t >= end ? 'hidden' : 'visible';
      lock.style.opacity = 1 - opening;
      lock.style.transform = `translateY(${-24 * opening}px) scale(${1 + .09 * opening})`;
      lock.style.filter = `blur(${opening * 7}px)`;
      lock.setAttribute('aria-hidden', String(t >= end));
      messages.style.opacity = opening;
      messages.style.transform = `scale(${.9 + .1 * opening})`;
      messages.setAttribute('aria-hidden', String(t < end));
      const press = Math.max(0, 1 - Math.abs(t - tapAt) / .16);
      card.style.opacity = arrived;
      card.style.transform = `translateY(${(1 - arrived) * -38}px) scale(${1 - press * .035})`;
      const approach = ease((t - (tapAt - .5)) / .5);
      const x = card.offsetLeft + card.offsetWidth * .68, y = card.offsetTop + card.offsetHeight * .6;
      touch.style.left = `${x - 14 + (1 - approach) * 28}px`;
      touch.style.top = `${y - 14 + (1 - approach) * 90}px`;
      touch.style.opacity = t < tapAt - .5 ? 0 : clamp((t - tapAt + .5) * 8) * (1 - clamp((t - tapAt) / .25));
      touch.style.transform = `scale(${1 - press * .3})`;
      const pulse = clamp((t - tapAt) / .45);
      ring.style.left = `${x - 16}px`; ring.style.top = `${y - 16}px`;
      ring.style.opacity = t < tapAt ? 0 : 1 - pulse;
      ring.style.transform = `scale(${1 + pulse * 2})`;
    },
  };
};
