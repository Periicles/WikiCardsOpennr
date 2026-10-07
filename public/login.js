document.getElementById('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('password').value }),
  });
  if (res.ok) location.href = '/';
  else err.textContent = (await res.json().catch(() => ({}))).error || 'Erreur de connexion';
});
