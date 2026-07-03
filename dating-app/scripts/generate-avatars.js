#!/usr/bin/env node
// Script to generate 20 flat-art SVG avatars for Delulu app
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '../public/avatars');

// Color palettes (skin tones, hair, accessories)
const skinTones = ['#FDBCB4','#F1C27D','#E0A869','#C68642','#8D5524','#4C3220'];
const hairColors = ['#2C1810','#8B4513','#D4A017','#F4E04D','#FF6B6B','#A0522D','#1a1a1a','#556B2F'];
const accentColors = ['#a53b29','#765848','#E07B54','#C9956C','#8B7355','#D4845A'];
const bgColors = ['#ffdad4','#ffdbca','#fdd4c0','#e4e2e1','#f0eded','#ffdad4','#dec0ba','#fdd4c0'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Female avatar shapes - varied hair styles
function femaleSVG(idx) {
  const skin = skinTones[idx % skinTones.length];
  const hair = hairColors[idx % hairColors.length];
  const bg = bgColors[idx % bgColors.length];
  const accent = accentColors[idx % accentColors.length];
  const hairStyles = [
    // Long straight
    `<path d="M50 18 Q30 22 28 45 Q26 60 30 75 Q28 90 35 95 Q38 98 40 95 Q38 88 40 80 Q50 85 60 80 Q62 88 60 95 Q62 98 65 95 Q72 90 70 75 Q74 60 72 45 Q70 22 50 18Z" fill="${hair}"/>`,
    // Wavy long
    `<path d="M50 18 Q28 22 27 48 Q24 65 28 80 Q25 92 32 95 Q36 97 38 93 Q36 85 38 78 Q50 84 62 78 Q64 85 62 93 Q64 97 68 95 Q75 92 72 80 Q76 65 73 48 Q72 22 50 18Z" fill="${hair}"/><path d="M30 55 Q26 62 29 68" fill="none" stroke="${hair}" stroke-width="3" stroke-linecap="round"/><path d="M70 55 Q74 62 71 68" fill="none" stroke="${hair}" stroke-width="3" stroke-linecap="round"/>`,
    // Bob
    `<path d="M50 18 Q30 20 29 42 Q28 58 32 68 Q40 72 50 72 Q60 72 68 68 Q72 58 71 42 Q70 20 50 18Z" fill="${hair}"/>`,
    // Bun
    `<path d="M50 18 Q33 21 32 40 Q31 55 35 70 Q36 78 40 80 Q50 78 60 80 Q64 78 65 70 Q69 55 68 40 Q67 21 50 18Z" fill="${hair}"/><circle cx="50" cy="14" r="9" fill="${hair}"/><circle cx="50" cy="14" r="5" fill="${accent}" opacity="0.4"/>`,
    // Ponytail
    `<path d="M50 18 Q31 21 30 42 Q29 57 33 70 Q40 76 50 74 Q60 76 67 70 Q71 57 70 42 Q69 21 50 18Z" fill="${hair}"/><path d="M50 74 Q52 85 54 95 Q52 98 50 98 Q48 98 46 95 Q48 85 50 74Z" fill="${hair}"/>`,
    // Short curly
    `<path d="M50 20 Q32 22 31 42 Q30 55 34 66 Q42 70 50 70 Q58 70 66 66 Q70 55 69 42 Q68 22 50 20Z" fill="${hair}"/><circle cx="35" cy="30" r="5" fill="${hair}"/><circle cx="65" cy="30" r="5" fill="${hair}"/><circle cx="42" cy="22" r="4" fill="${hair}"/><circle cx="58" cy="22" r="4" fill="${hair}"/>`,
    // Space buns
    `<path d="M50 22 Q34 24 33 44 Q32 58 36 70 Q44 75 50 74 Q56 75 64 70 Q68 58 67 44 Q66 24 50 22Z" fill="${hair}"/><circle cx="35" cy="24" r="8" fill="${hair}"/><circle cx="65" cy="24" r="8" fill="${hair}"/>`,
    // Side part long
    `<path d="M50 18 Q32 20 30 44 Q28 62 32 78 Q30 90 36 94 Q38 96 40 93 Q38 84 40 76 Q50 82 62 76 Q64 84 62 93 Q64 96 66 94 Q72 90 70 78 Q74 62 72 44 Q70 20 55 16 Q52 15 50 18Z" fill="${hair}"/>`,
    // Afro
    `<ellipse cx="50" cy="34" rx="22" ry="20" fill="${hair}"/><ellipse cx="32" cy="42" rx="10" ry="12" fill="${hair}"/><ellipse cx="68" cy="42" rx="10" ry="12" fill="${hair}"/>`,
    // Half up
    `<path d="M50 18 Q31 21 30 42 Q29 57 33 70 Q40 76 50 74 Q60 76 67 70 Q71 57 70 42 Q69 21 50 18Z" fill="${hair}"/><path d="M35 38 Q50 34 65 38" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>`,
  ];
  const style = hairStyles[idx % hairStyles.length];

  // Optional accessories
  const accessories = [
    '',
    `<circle cx="38" cy="57" r="2.5" fill="${accent}"/><circle cx="62" cy="57" r="2.5" fill="${accent}"/>`, // earrings
    `<rect x="36" y="54" width="7" height="5" rx="2" fill="none" stroke="${accent}" stroke-width="1.5"/>`, // glasses left
    `<rect x="36" y="54" width="7" height="5" rx="2" fill="none" stroke="#555" stroke-width="1.5"/><rect x="57" y="54" width="7" height="5" rx="2" fill="none" stroke="#555" stroke-width="1.5"/><line x1="43" y1="56.5" x2="57" y2="56.5" stroke="#555" stroke-width="1"/>`, // full glasses
    `<path d="M44 56 Q50 61 56 56" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>`, // smile accessory
    `<circle cx="62" cy="57" r="2" fill="${accent}"/>`, // single earring
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200">
  <circle cx="50" cy="50" r="50" fill="${bg}"/>
  ${style}
  <!-- Face -->
  <ellipse cx="50" cy="52" rx="18" ry="20" fill="${skin}"/>
  <!-- Eyes -->
  <ellipse cx="43" cy="49" rx="3" ry="3.5" fill="white"/>
  <ellipse cx="57" cy="49" rx="3" ry="3.5" fill="white"/>
  <circle cx="43" cy="50" r="2" fill="#2C1810"/>
  <circle cx="57" cy="50" r="2" fill="#2C1810"/>
  <circle cx="44" cy="49" r="0.7" fill="white"/>
  <circle cx="58" cy="49" r="0.7" fill="white"/>
  <!-- Eyebrows -->
  <path d="M40 45.5 Q43 44 46 45.5" fill="none" stroke="${hair}" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M54 45.5 Q57 44 60 45.5" fill="none" stroke="${hair}" stroke-width="1.5" stroke-linecap="round"/>
  <!-- Nose -->
  <path d="M49 52 Q50 55 51 52" fill="none" stroke="${skin}" stroke-width="1.2" stroke-linecap="round" filter="brightness(0.85)"/>
  <circle cx="48" cy="54.5" r="1" fill="${skin}" filter="brightness(0.88)"/>
  <circle cx="52" cy="54.5" r="1" fill="${skin}" filter="brightness(0.88)"/>
  <!-- Mouth -->
  <path d="M45 59 Q50 63 55 59" fill="none" stroke="${accent}" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M46 59 Q50 62 54 59" fill="${accent}" opacity="0.3"/>
  <!-- Cheeks blush -->
  <ellipse cx="39" cy="57" rx="4" ry="2.5" fill="${accent}" opacity="0.15"/>
  <ellipse cx="61" cy="57" rx="4" ry="2.5" fill="${accent}" opacity="0.15"/>
  ${accessories[idx % accessories.length]}
  <!-- Neck & Body -->
  <rect x="44" y="71" width="12" height="8" rx="3" fill="${skin}"/>
  <path d="M28 100 Q30 80 50 78 Q70 80 72 100Z" fill="${accent}"/>
</svg>`;
}

function maleSVG(idx) {
  const skin = skinTones[idx % skinTones.length];
  const hair = hairColors[(idx + 3) % hairColors.length];
  const bg = bgColors[(idx + 4) % bgColors.length];
  const accent = accentColors[(idx + 2) % accentColors.length];

  const hairStyles = [
    // Short neat
    `<path d="M50 20 Q32 22 31 38 Q30 44 32 46 Q35 48 38 46 Q40 52 50 52 Q60 52 62 46 Q65 48 68 46 Q70 44 69 38 Q68 22 50 20Z" fill="${hair}"/>`,
    // Slicked back
    `<path d="M50 18 Q33 20 32 38 Q34 42 50 40 Q66 42 68 38 Q67 20 50 18Z" fill="${hair}"/>`,
    // Side fade
    `<path d="M50 19 Q36 21 35 38 Q40 44 50 44 Q60 44 65 38 Q64 21 50 19Z" fill="${hair}"/>`,
    // Messy
    `<path d="M50 19 Q33 21 32 40 Q34 46 50 44 Q66 46 68 40 Q67 21 50 19Z" fill="${hair}"/><path d="M38 22 Q34 18 36 16" fill="none" stroke="${hair}" stroke-width="3" stroke-linecap="round"/><path d="M50 19 Q48 14 52 13" fill="none" stroke="${hair}" stroke-width="3" stroke-linecap="round"/><path d="M62 22 Q66 18 64 16" fill="none" stroke="${hair}" stroke-width="3" stroke-linecap="round"/>`,
    // Curly top
    `<path d="M50 22 Q34 24 33 42 Q36 48 50 48 Q64 48 67 42 Q66 24 50 22Z" fill="${hair}"/><circle cx="40" cy="22" r="5" fill="${hair}"/><circle cx="50" cy="19" r="6" fill="${hair}"/><circle cx="60" cy="22" r="5" fill="${hair}"/>`,
    // Undercut
    `<path d="M50 20 Q38 21 37 36 Q40 42 50 42 Q60 42 63 36 Q62 21 50 20Z" fill="${hair}"/>`,
    // Crew cut
    `<path d="M50 21 Q34 23 33 39 Q36 45 50 45 Q64 45 67 39 Q66 23 50 21Z" fill="${hair}"/><path d="M34 36 Q32 30 34 26 Q40 22 50 21 Q60 22 66 26 Q68 30 66 36" fill="${hair}"/>`,
    // Long hair
    `<path d="M50 18 Q30 20 29 40 Q28 55 32 68 Q30 78 34 82 Q36 84 38 82 Q36 74 38 66 Q50 72 62 66 Q64 74 62 82 Q64 84 66 82 Q70 78 68 68 Q72 55 71 40 Q70 20 50 18Z" fill="${hair}"/>`,
    // Mohawk
    `<path d="M50 20 Q36 22 35 40 Q38 46 50 46 Q62 46 65 40 Q64 22 50 20Z" fill="${hair}"/><rect x="47" y="10" width="6" height="14" rx="3" fill="${hair}"/>`,
    // Buzz
    `<path d="M50 22 Q35 24 34 40 Q36 46 50 47 Q64 46 66 40 Q65 24 50 22Z" fill="${hair}" opacity="0.7"/>`,
  ];
  const style = hairStyles[idx % hairStyles.length];

  const accessories = [
    '',
    // Beard stubble
    `<path d="M38 64 Q50 70 62 64" fill="${hair}" opacity="0.3" stroke="${hair}" stroke-width="1"/>`,
    // Glasses
    `<rect x="36" y="54" width="7" height="5" rx="2" fill="none" stroke="#555" stroke-width="1.5"/><rect x="57" y="54" width="7" height="5" rx="2" fill="none" stroke="#555" stroke-width="1.5"/><line x1="43" y1="56.5" x2="57" y2="56.5" stroke="#555" stroke-width="1"/>`,
    // Light beard
    `<path d="M37 60 Q50 70 63 60 Q65 68 50 72 Q35 68 37 60Z" fill="${hair}" opacity="0.25"/>`,
    // Mustache
    `<path d="M44 59 Q50 62 56 59 Q53 57 50 58 Q47 57 44 59Z" fill="${hair}" opacity="0.5"/>`,
    '',
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200">
  <circle cx="50" cy="50" r="50" fill="${bg}"/>
  ${style}
  <!-- Face -->
  <ellipse cx="50" cy="53" rx="17" ry="19" fill="${skin}"/>
  <!-- Ears -->
  <ellipse cx="33" cy="53" rx="3.5" ry="4.5" fill="${skin}"/>
  <ellipse cx="67" cy="53" rx="3.5" ry="4.5" fill="${skin}"/>
  <!-- Eyes -->
  <ellipse cx="43" cy="50" rx="3" ry="3" fill="white"/>
  <ellipse cx="57" cy="50" rx="3" ry="3" fill="white"/>
  <circle cx="43" cy="50.5" r="2" fill="#2C1810"/>
  <circle cx="57" cy="50.5" r="2" fill="#2C1810"/>
  <circle cx="44" cy="49.5" r="0.7" fill="white"/>
  <circle cx="58" cy="49.5" r="0.7" fill="white"/>
  <!-- Eyebrows (straighter for male) -->
  <path d="M40 46 Q43 45 46 46" fill="none" stroke="${hair}" stroke-width="2" stroke-linecap="round"/>
  <path d="M54 46 Q57 45 60 46" fill="none" stroke="${hair}" stroke-width="2" stroke-linecap="round"/>
  <!-- Nose -->
  <path d="M49 53 Q47 57 50 58 Q53 57 51 53Z" fill="${skin}" filter="brightness(0.85)"/>
  <!-- Mouth -->
  <path d="M45 62 Q50 65 55 62" fill="none" stroke="${accent}" stroke-width="1.8" stroke-linecap="round"/>
  ${accessories[idx % accessories.length]}
  <!-- Neck & Body -->
  <rect x="43" y="71" width="14" height="9" rx="3" fill="${skin}"/>
  <path d="M24 100 Q28 78 50 76 Q72 78 76 100Z" fill="${accent}"/>
</svg>`;
}

// Write all 20 files
for (let i = 1; i <= 10; i++) {
  const fname = path.join(OUT, `female_0${i > 9 ? '' : '0'}${i}`.replace('_0', '_0').replace('female_0', `female_0`));
  const filename = path.join(OUT, `female_${String(i).padStart(2,'0')}.svg`);
  fs.writeFileSync(filename, femaleSVG(i - 1));
  console.log(`✅ ${filename}`);
}
for (let i = 1; i <= 10; i++) {
  const filename = path.join(OUT, `male_${String(i).padStart(2,'0')}.svg`);
  fs.writeFileSync(filename, maleSVG(i - 1));
  console.log(`✅ ${filename}`);
}
console.log('Done! 20 SVG avatars generated.');
