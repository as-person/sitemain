document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("snow");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  resize();
  window.addEventListener("resize", resize);

  const flakes = [];

  // Определяем мобильное устройство
  const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(navigator.userAgent);

  // Кол-во снега: меньше на мобильных
  const COUNT = isMobile ? 60 : 110;

  let wind = 0;
  let windTarget = 0;
  let windTimer = 0;

  // ——— Плавный ветер ———
  function updateWind() {
    windTimer++;
    if (windTimer > 240) {               
      windTimer = 0;
      windTarget = (Math.random() - 0.5) * 0.3; 
    }
    wind += (windTarget - wind) * 0.003; 
  }

  // ——— Создание снежинок ———
  for (let i = 0; i < COUNT; i++) {
    flakes.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,

      r: Math.random() * 0.7 + 0.35,

      // Ускоряем падение на мобильных (около +60%)
      s: (Math.random() * 0.6 + 0.3) * (isMobile ? 1.6 : 1),

      driftSeed: Math.random() * 1000,
    });
  }

  // ——— Анимация ———
  function animate(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    updateWind();
    ctx.fillStyle = "rgba(255,255,255,0.85)";

    for (const f of flakes) {
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();

      f.y += f.s;

      // Плавное боковое смещение
      f.x += wind + Math.sin(t * 0.0004 + f.driftSeed) * 0.08;

      if (f.y > canvas.height) {
        f.y = -5;
        f.x = Math.random() * canvas.width;
      }

      if (f.x < -5) f.x = canvas.width + 5;
      if (f.x > canvas.width + 5) f.x = -5;
    }

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
});
