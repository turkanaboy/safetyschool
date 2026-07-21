const RUNTIME_ROOT = '/assets/university-quad/Runtime';
const DEPARTMENTS = ['academics', 'studentAffairs', 'athletics', 'admissions', 'marketing', 'administration'];
const PAD_IDS = {
  academics: 'academics',
  studentAffairs: 'student-affairs',
  athletics: 'athletics',
  admissions: 'admissions',
  marketing: 'marketing',
  administration: 'administration',
};
const PEOPLE = [
  ['person--walker', 650, 480],
  ['person--walker person--northwest', 720, 560],
  ['person--runner', 850, 460],
  ['person--walker', 910, 610],
  ['person--seated', 760, 650],
  ['person--walker person--northwest', 970, 500],
  ['person--frisbee', 620, 625],
  ['person--frisbee', 865, 660],
  ['person--runner', 1050, 585],
  ['person--walker', 690, 710],
];
const ROUTES = [
  [[650, 480], [790, 560]],
  [[720, 560], [600, 480]],
  [[850, 460], [980, 535]],
  [[910, 610], [790, 675]],
  [[970, 500], [1090, 575]],
  [[1050, 585], [900, 690]],
  [[690, 710], [810, 615]],
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function assetUrl(path) {
  if (typeof path !== 'string') throw new TypeError(`Invalid university quad runtime path: ${path}`);
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new TypeError(`Invalid university quad runtime path: ${path}`);
  }
  return `${RUNTIME_ROOT}/${normalized}`;
}

function validateRuntime(runtime) {
  const padIds = runtime?.pads?.map(({ id }) => id).sort();
  const expected = Object.values(PAD_IDS).sort();
  if (runtime?.schemaVersion !== 1 || JSON.stringify(padIds) !== JSON.stringify(expected)) {
    throw new TypeError('University quad runtime manifest must define the six canonical pads.');
  }
  if (runtime.coordinateSpace?.width !== runtime.board?.size?.[0]
    || runtime.coordinateSpace?.height !== runtime.board?.size?.[1]) {
    throw new TypeError('University quad board and coordinate space do not match.');
  }
  [runtime.board.image, runtime.fountain?.staticFallbackImage,
    ...Object.values(runtime.buildingTemplate?.images ?? {})].forEach(assetUrl);
  return runtime;
}

function campusCondition(own, runtime) {
  let key = 'prosperity';
  let label = 'Building momentum';
  if (own.enteredAusterity || own.treasury < 0) {
    key = 'austerity';
    label = 'Austerity';
  } else if (own.strainedRounds > 0 || own.treasury < 10) {
    key = 'strain';
    label = 'Campus strain';
  } else if (own.treasury >= 40 && own.reputation >= 55) {
    label = 'Prosperous';
  }
  const state = runtime.campusStates[key];
  return {
    key,
    label,
    population: state.population,
    frisbee: state.frisbee,
    maintenance: Boolean(state.maintenanceCue),
    protest: Boolean(state.protestCue),
    grass: state.grass,
    grassDark: state.grassDark,
    buildingSaturation: state.buildingSaturation,
  };
}

export function campusPresentation(own, inputRuntime) {
  const runtime = validateRuntime(inputRuntime);
  const { width, height } = runtime.coordinateSpace;
  const worldDepthBase = Number(runtime.depth.worldObject.match(/^\d+/)?.[0] ?? 30000);
  const buildings = DEPARTMENTS.map((department) => {
    const padId = PAD_IDS[department];
    const pad = runtime.pads.find(({ id }) => id === padId);
    const level = own.departments[department];
    const xs = pad.footprint.map(([x]) => x);
    const padWidth = Math.max(...xs) - Math.min(...xs);
    return {
      department,
      name: pad.department,
      level,
      image: assetUrl(runtime.buildingTemplate.images[padId]),
      leftPercent: pad.placementPivot[0] / width * 100,
      topPercent: pad.placementPivot[1] / height * 100,
      widthPercent: padWidth * runtime.buildingTemplate.levelPadCoverage[String(level)] / width * 100,
      depth: worldDepthBase + Math.round(pad.placementPivot[1]),
    };
  });
  return { buildings, condition: campusCondition(own, runtime) };
}

export function renderCampusBoard(own, runtime, characters) {
  if (characters?.schemaVersion !== 1 || characters.canonicalPayload !== 'atlas' || characters.frames?.length !== 16) {
    throw new TypeError('University quad character atlas contract is invalid.');
  }
  const { buildings, condition } = campusPresentation(own, runtime);
  const { width, height } = runtime.coordinateSpace;
  const [pivotX, pivotY] = characters.frames[0].pivot;
  const buildingMarkup = buildings.map((building) => `
    <div class="building online-building" role="img" data-department="${building.department}" data-level="${building.level}"
      aria-label="${escapeHtml(building.name)}, Level ${building.level}"
      style="--online-building-size:${building.widthPercent}%;left:${building.leftPercent}%;top:${building.topPercent}%;z-index:${building.depth}">
      <span class="building__model" aria-hidden="true"><img src="${building.image}" alt=""></span>
      <span class="building__dust" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="building__caption"><strong>${escapeHtml(building.name)}</strong><span>Level <b>${building.level}</b></span></span>
    </div>`).join('');
  const peopleMarkup = PEOPLE.map(([classes, x, y], index) => `<i class="person ${classes}" data-route-index="${index}" style="left:${x / width * 100}%;top:${y / height * 100}%;z-index:${30000 + y}"></i>`).join('');
  const fountain = runtime.fountain;
  const fountainTransform = `translate(${-fountain.staticFallbackPivot[0] / fountain.staticFallbackSize[0] * 100}%, ${-fountain.staticFallbackPivot[1] / fountain.staticFallbackSize[1] * 100}%)`;
  const boardStyle = `--student-atlas:url(&quot;${assetUrl(`Characters/${characters.image}`)}&quot;);--student-pivot-x:${-pivotX / characters.frameWidth * 100}%;--student-pivot-y:${-pivotY / characters.frameHeight * 100}%`;

  return `<section class="campus-board online-campus" aria-label="${escapeHtml(own.name)} campus" style="${boardStyle}">
    <span class="campus-condition">${escapeHtml(condition.label)}</span>
    <div class="campus-map online-campus-map">
      <img class="campus-map__base" src="${assetUrl(runtime.board.image)}" alt="">
      <div class="quad__fountain" style="left:${fountain.boardPivot[0] / width * 100}%;top:${fountain.boardPivot[1] / height * 100}%;width:${fountain.staticFallbackDisplayWidth / width * 100}%;transform:${fountainTransform};z-index:${runtime.depth.fountain}"><img src="${assetUrl(fountain.staticFallbackImage)}" alt=""></div>
      ${buildingMarkup}
      <div class="campus-life" aria-hidden="true">${peopleMarkup}<b class="frisbee"></b></div>
      <div class="campus-ambience" aria-hidden="true"><i class="bird bird--one"></i><i class="bird bird--two"></i><i class="campus-flag"></i></div>
      <div class="protest" aria-hidden="true"><i></i><i></i><i></i><i></i><span>Fund students, not slogans</span></div>
      <div class="maintenance-cue" aria-hidden="true"><i></i><i></i><i></i><span>Deferred maintenance</span></div>
    </div>
    <div class="campus-board__edge"><span>Founded 1912</span><strong>${escapeHtml(own.name).toUpperCase()} UNIVERSITY</strong><span>Live campus</span></div>
  </section>`;
}

export function applyCampusEnvironment(condition) {
  document.body.dataset.campusState = condition.key;
  document.body.dataset.population = String(condition.population);
  document.body.dataset.frisbee = condition.frisbee ? 'on' : 'off';
  document.body.dataset.maintenance = condition.maintenance ? 'on' : 'off';
  document.body.dataset.protest = condition.protest ? 'on' : 'off';
  document.documentElement.style.setProperty('--campus-grass', condition.grass);
  document.documentElement.style.setProperty('--campus-dark', condition.grassDark);
  document.documentElement.style.setProperty('--building-saturation', String(condition.buildingSaturation));
}

export function clearCampusEnvironment() {
  for (const name of ['campusState', 'population', 'frisbee', 'maintenance', 'protest']) delete document.body.dataset[name];
}

export function startCampusMotion(root, runtime) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const { width, height } = runtime.coordinateSpace;
  const worldDepthBase = Number(runtime.depth.worldObject.match(/^\d+/)?.[0] ?? 30000);
  const animations = [...root.querySelectorAll('.person:not(.person--seated):not(.person--frisbee)')].map((person, index) => {
    const route = ROUTES[index % ROUTES.length];
    return person.animate(route.map(([x, y]) => ({
      left: `${x / width * 100}%`,
      top: `${y / height * 100}%`,
      zIndex: String(worldDepthBase + Math.round(y)),
    })), {
      duration: person.classList.contains('person--runner') ? 9000 : 15000,
      delay: index * -1300,
      direction: 'alternate',
      easing: 'linear',
      iterations: Infinity,
    });
  });
  return () => animations.forEach((animation) => animation.cancel());
}
