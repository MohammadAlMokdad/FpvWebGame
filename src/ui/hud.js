const $ = (id) => document.getElementById(id);
const RADAR_RANGE = 140; // metres from the drone to the radar edge
const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

// Betaflight-style on-screen display.
export class Hud {
  constructor() {
    this.root = $('hud');
    this.el = {
      timer: $('timer'), alt: $('alt'), spd: $('spd'), hull: $('hull'), hullFill: $('hull-fill'),
      wave: $('wave'), hostiles: $('hostiles'), score: $('score'), hiscore: $('hiscore'),
      integrity: $('integrity'), integrityFill: $('integrity-fill'), integrityPct: $('integrity-pct'),
      lq: $('lq'), sigBars: $('sig-bars'), killfeed: $('killfeed'), banner: $('banner'), alert: $('alert'),
      hitmarker: $('hitmarker'), arrows: $('dmg-arrows'), muzzle: $('muzzle'), lost: $('lost'),
      lostCount: $('lost-count'), mute: $('mute-ind'), rc: document.querySelector('.osd.rc'),
      ammo: $('ammo'), missiles: $('missiles'), ammoRow: $('ammo-row'), missileRow: $('missile-row'),
      visionTag: $('vision-tag'),
    };
    this.compass = $('compass').getContext('2d');
    this.radar = $('radar').getContext('2d');
    this.textTimer = 0;
    this.canvasTimer = 0;
    this.bannerTimer = 0;
    this.bannerSticky = false;
  }

  setVisible(v) {
    this.root.classList.toggle('hidden', !v);
  }

  // Camera mode tag next to REC (hidden by day).
  setVision(mode) {
    const label = { thermal: 'IR-COLOR', green: 'NV-GRN', white: 'NV-MONO' }[mode];
    this.el.visionTag.textContent = label ?? '';
    this.el.visionTag.classList.toggle('hidden', !label);
  }

  setMuted(m) {
    this.el.mute.classList.toggle('hidden', !m);
  }

  // Called every frame; text fields refresh at ~10 Hz.
  update(dt, s) {
    this.textTimer -= dt;
    if (this.textTimer <= 0) {
      this.textTimer = 0.1;
      const e = this.el;
      const t = Math.floor(s.missionTime);
      e.timer.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      e.alt.textContent = Math.max(0, Math.round(s.drone.altitude));
      e.spd.textContent = Math.round(s.drone.speed * 3.6);
      const hull = Math.ceil(s.drone.hp);
      e.hull.textContent = hull;
      e.hullFill.style.width = `${hull}%`;
      e.rc.classList.toggle('low', hull < 35);
      e.wave.textContent = s.wave;
      const { ammo, rockets, issued } = s.weapon;
      e.ammo.textContent = ammo;
      e.missiles.textContent = rockets;
      e.ammoRow.classList.toggle('empty', ammo <= 0);
      e.ammoRow.classList.toggle('low', ammo > 0 && ammo < issued.ammo * 0.2);
      e.missileRow.classList.toggle('empty', rockets <= 0);
      e.missileRow.classList.toggle('low', rockets === 1);
      e.hostiles.textContent = s.hostiles;
      e.score.textContent = s.score.toLocaleString();
      e.hiscore.textContent = Math.max(s.highScore, s.score).toLocaleString();
      const integ = Math.max(0, Math.ceil(s.integrity));
      e.integrityPct.textContent = `${integ}%`;
      e.integrityFill.style.width = `${integ}%`;
      e.integrityFill.style.background = integ > 60 ? 'var(--green)' : integ > 30 ? 'var(--amber)' : 'var(--red)';
      e.integrity.classList.toggle('critical', integ <= 30);
      const sig = s.drone.signal;
      e.lq.textContent = `LQ ${Math.round(sig * 100)}`;
      const bars = Math.ceil(sig * 5);
      [...e.sigBars.children].forEach((b, i) => b.classList.toggle('off', i >= bars));
      e.sigBars.classList.toggle('low', bars <= 2);
      e.lost.classList.toggle('show', s.drone.downed && s.drone.lossLevel > 0.6);
      e.lostCount.textContent = Math.max(1, Math.ceil(s.drone.downTimer));
      if (s.countdown !== null) {
        // Don't cut short a one-off banner such as "WAVE 3 CLEARED".
        if (this.bannerSticky || this.bannerTimer <= 0) {
          this.showBanner(s.countdownTitle, `NEXT WAVE IN ${Math.ceil(s.countdown)}`, 0.3, true);
        }
      } else if (this.bannerSticky) {
        this.bannerSticky = false;
        this.bannerTimer = 0;
      }
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.el.banner.classList.remove('show');
    }
    this.el.muzzle.style.opacity = s.muzzleFlash > 0 ? (0.6 + Math.random() * 0.4).toFixed(2) : '0';
    // Canvas instruments redraw at ~30 Hz.
    this.canvasTimer -= dt;
    if (this.canvasTimer <= 0) {
      this.canvasTimer = 1 / 30;
      this.drawCompass(s.drone);
      this.drawRadar(s.drone, s.enemies);
    }
  }

  showBanner(title, sub = '', duration = 2.5, sticky = false) {
    const b = this.el.banner;
    b.querySelector('.title').textContent = title;
    b.querySelector('.sub').textContent = sub;
    b.classList.add('show');
    this.bannerTimer = duration;
    this.bannerSticky = sticky;
  }

  showAlert(text) {
    const a = this.el.alert;
    a.textContent = text;
    a.classList.remove('show');
    void a.offsetWidth;
    a.classList.add('show');
  }

  hitMarker(headshot, killed) {
    const h = this.el.hitmarker;
    h.classList.remove('show', 'head', 'kill');
    void h.offsetWidth;
    h.classList.add('show');
    if (headshot) h.classList.add('head');
    if (killed) h.classList.add('kill');
  }

  killFeed(text, headshot) {
    const d = document.createElement('div');
    d.textContent = text;
    if (headshot) d.className = 'head';
    this.el.killfeed.prepend(d);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
    setTimeout(() => d.remove(), 2700);
  }

  damageArrow(angle) {
    const a = document.createElement('div');
    a.className = 'arrow';
    a.style.transform = `rotate(${angle}rad)`;
    a.addEventListener('animationend', () => a.remove());
    this.el.arrows.appendChild(a);
  }

  clearTransient() {
    this.el.killfeed.replaceChildren();
    this.el.arrows.replaceChildren();
    this.el.banner.classList.remove('show');
    this.el.alert.classList.remove('show');
    this.bannerTimer = 0;
  }

  drawCompass(drone) {
    const g = this.compass;
    const { width: w, height: h } = g.canvas;
    g.clearRect(0, 0, w, h);
    g.font = '15px "Share Tech Mono", monospace';
    g.textAlign = 'center';
    g.lineWidth = 3;
    const heading = drone.heading;
    const pxPerDeg = w / 140;
    const outlined = (fn) => {
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      fn(true);
      g.strokeStyle = g.fillStyle = '#eef3ec';
      fn(false);
    };
    for (let d = Math.ceil((heading - 70) / 5) * 5; d <= heading + 70; d += 5) {
      const x = w / 2 + (d - heading) * pxPerDeg;
      const deg = ((d % 360) + 360) % 360;
      const major = deg % 45 === 0;
      const tall = major ? 12 : deg % 15 === 0 ? 8 : 4;
      outlined((stroke) => {
        g.lineWidth = stroke ? 4 : 1.5;
        g.beginPath();
        g.moveTo(x, h - 2);
        g.lineTo(x, h - 2 - tall);
        g.stroke();
        if (major) {
          if (stroke) g.strokeText(CARDINALS[deg], x, 15);
          else g.fillText(CARDINALS[deg], x, 15);
        }
      });
    }
    // Bearing to the base ("H" for home).
    const bearing = ((Math.atan2(-drone.position.x, drone.position.z) * 180 / Math.PI) + 360) % 360;
    const rel = ((bearing - heading + 540) % 360) - 180;
    const clamped = Math.max(-68, Math.min(68, rel));
    const hx = w / 2 + clamped * pxPerDeg;
    g.fillStyle = '#ffb43c';
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.lineWidth = 3;
    g.strokeText('H', hx, 32);
    g.fillText('H', hx, 32);
    g.fillStyle = '#ff4535';
    g.beginPath();
    g.moveTo(w / 2 - 6, 0);
    g.lineTo(w / 2 + 6, 0);
    g.lineTo(w / 2, 8);
    g.fill();
  }

  drawRadar(drone, enemies) {
    const g = this.radar;
    const { width: w } = g.canvas;
    const c = w / 2;
    const scale = (c - 8) / RADAR_RANGE;
    g.clearRect(0, 0, w, w);
    g.fillStyle = 'rgba(6, 14, 8, 0.55)';
    g.strokeStyle = 'rgba(238, 243, 236, 0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(c, c, c - 2, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(c, c, (c - 2) / 2, 0, Math.PI * 2);
    g.stroke();
    // View cone.
    g.strokeStyle = 'rgba(238, 243, 236, 0.18)';
    g.beginPath();
    g.moveTo(c, c);
    g.lineTo(c - c * 0.9, c - c * 0.65);
    g.moveTo(c, c);
    g.lineTo(c + c * 0.9, c - c * 0.65);
    g.stroke();

    const fx = drone.forward.x;
    const fz = drone.forward.z;
    const rx = drone.right.x;
    const rz = drone.right.z;
    const toRadar = (x, z) => {
      const dx = x - drone.position.x;
      const dz = z - drone.position.z;
      let px = (dx * rx + dz * rz) * scale;
      let py = -(dx * fx + dz * fz) * scale;
      const len = Math.hypot(px, py);
      const max = c - 6;
      const edge = len > max;
      if (edge) {
        px *= max / len;
        py *= max / len;
      }
      return [c + px, c + py, edge];
    };

    // Base outline (40 m square).
    const corners = [[-20, -20], [20, -20], [20, 20], [-20, 20]].map(([x, z]) => toRadar(x, z));
    g.strokeStyle = 'rgba(134, 255, 143, 0.9)';
    g.lineWidth = 1.5;
    g.beginPath();
    corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.stroke();

    for (const s of enemies) {
      if (!s.alive) continue;
      const [x, y, edge] = toRadar(s.root.position.x, s.root.position.z);
      g.fillStyle = s.type === 'gunner' ? '#ffb43c' : '#ff4535';
      g.beginPath();
      g.arc(x, y, edge ? 2 : 3, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#eef3ec';
    g.beginPath();
    g.moveTo(c, c - 6);
    g.lineTo(c - 4, c + 4);
    g.lineTo(c + 4, c + 4);
    g.fill();
  }
}
