// Genera www/ : index.html (sin CDN), app.css (Tailwind compilado) y fuentes locales.
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const root = path.join(__dirname, '..');
const www = path.join(root, 'www');
fs.mkdirSync(path.join(www, 'fonts'), { recursive: true });

let html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
fs.writeFileSync(path.join(www, 'index.html'), html);
for (const f of ['chords.js', 'pcm.js', 'shapes.js', 'transcribe.js']) fs.copyFileSync(path.join(root, 'src', f), path.join(www, f));

for (const [pkg, files] of [['inter', [300,400,500,600,700,800]], ['jetbrains-mono', [400,500,600,700]]]) {
  for (const w of files) {
    const f = `${pkg}-latin-${w}-normal.woff2`;
    fs.copyFileSync(path.join(root, 'node_modules/@fontsource', pkg, 'files', f), path.join(www, 'fonts', f));
  }
}
execSync('npx esbuild src/pitch.entry.mjs --bundle --format=iife --global-name=PitchShift --minify --outfile=www/pitch.js --log-level=warning', { cwd: root, stdio: 'inherit' });
execSync('npx tailwindcss -c tailwind.config.js -i src/input.css -o www/app.css --minify', { cwd: root, stdio: 'inherit' });
console.log('www/ listo');
