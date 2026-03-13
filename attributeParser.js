// attributeParser.js
// Fetches Endless Sky C++ source files from GitHub and extracts attribute
// definitions, units, and calculation formulas, then writes them to
// data/attributeDefinitions.json alongside the other parser output.
//
// Source files parsed:
//   source/OutfitInfoDisplay.cpp  — display labels, units, groupings
//   source/Ship.cpp               — derived stat formulas (speed, accel, etc.)
//   source/Outfit.cpp             — attribute stacking rules
//
// Run standalone:  node attributeParser.js
// Or import and call parseAttributes() from your main workflow.

'use strict';

const https = require('https');
const fs    = require('fs').promises;
const path  = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ES_RAW_BASE = 'https://raw.githubusercontent.com/endless-sky/endless-sky/master/source';

const SOURCE_FILES = {
  outfitInfoDisplay: `${ES_RAW_BASE}/OutfitInfoDisplay.cpp`,
  ship:              `${ES_RAW_BASE}/Ship.cpp`,
  outfit:            `${ES_RAW_BASE}/Outfit.cpp`,
  shipInfoDisplay:   `${ES_RAW_BASE}/ShipInfoDisplay.cpp`,
};

// ---------------------------------------------------------------------------
// HTTP fetch helper
// ---------------------------------------------------------------------------

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Parse OutfitInfoDisplay.cpp
//
// This file contains calls like:
//   Add("Shield Generation:", outfit.Attributes().Get("shield generation") * 60., 2);
//   static const Table table = {
//     {"shield generation",   60.,   "/s",  2},
//     {"shield energy",      -60.,   "/s",  2},
//   };
// and TableDivider() calls that mark section headings.
//
// We extract:
//   - attribute key strings (in quotes)
//   - multipliers (convert from per-frame to per-second etc.)
//   - unit strings
//   - section grouping from TableDivider labels
// ---------------------------------------------------------------------------

function parseOutfitInfoDisplay(src) {
  const attributes = {};

  // ── Section headings from TableDivider ───────────────────────────────────
  // e.g.  table.AddDivider("Shields & Hull:");
  //       table.AddDivider("Engines");
  let currentSection = 'General';
  const dividerRe = /(?:TableDivider|AddDivider|table\.AddDivider)\s*\(\s*"([^"]+)"/g;

  // ── Attribute table entries ───────────────────────────────────────────────
  // Most attributes appear in a static initialiser table or in Add() calls.
  //
  // Patterns seen in OutfitInfoDisplay.cpp:
  //
  // 1. Table-initialiser row (4-field):
  //    {"shield generation",  60., "/s", 2},
  //    {"thrusting energy",  -60., "/frame", 2},
  //
  // 2. Table-initialiser row (3-field, no precision):
  //    {"shields",  1., ""},
  //
  // 3. Inline Add() call:
  //    table.Add("Shield Generation:", outfit.Attributes().Get("shield generation") * 60., 2);
  //
  // 4. Labelled Add with explicit unit in label:
  //    table.Add("Thrust (px/s^2):", ...);

  // Pattern 1 & 2: table row  {"key", multiplier, "unit"[, precision]}
  const tableRowRe = /\{\s*"([^"]+)"\s*,\s*(-?[\d.e+]+)\s*,\s*"([^"]*)"\s*(?:,\s*\d+\s*)?\}/g;

  // Pattern 3: Add("Label:", expr.Get("key") * multiplier, prec)
  const addCallRe = /(?:table\.)?Add\s*\(\s*"([^"]+):?"\s*,\s*[^.]*\.Get\s*\(\s*"([^"]+)"\s*\)\s*\*?\s*([\d.e+]*)/g;

  // ── Walk the source line-by-line so we can track section context ─────────
  const lines = src.split('\n');
  let inTable = false;

  for (const line of lines) {
    // Track section dividers
    const divMatch = line.match(/(?:TableDivider|AddDivider)\s*\(\s*"([^"]+)"/);
    if (divMatch) {
      currentSection = divMatch[1].replace(/:$/, '').trim();
      continue;
    }

    // Detect table open/close
    if (/static\s+const\s+.*[Tt]able\s*=/.test(line) || /\bTable\s+table\b/.test(line)) {
      inTable = true;
    }
    if (inTable && /^\s*\};/.test(line)) {
      inTable = false;
    }

    // Table row entries
    const rowMatch = line.match(/\{\s*"([^"]+)"\s*,\s*(-?[\d.e+]+)\s*,\s*"([^"]*)"/);
    if (rowMatch) {
      const [, key, multiplierStr, unit] = rowMatch;
      const multiplier = parseFloat(multiplierStr);
      if (!attributes[key]) {
        attributes[key] = {
          section:    currentSection,
          unit:       unit || '',
          multiplier: multiplier === 1 ? undefined : multiplier,
          formula:    buildFormulaFromMultiplier(key, multiplier, unit),
        };
      }
      continue;
    }

    // Add() call with .Get("key") pattern
    const addMatch = line.match(/\.Add\s*\(\s*"([^"]+)"\s*,.*\.Get\s*\(\s*"([^"]+)"\s*\)\s*\*?\s*([\d.e+]*)/);
    if (addMatch) {
      const [, label, key, multStr] = addMatch;
      const multiplier = multStr ? parseFloat(multStr) : 1;
      if (!attributes[key]) {
        attributes[key] = {
          section:    currentSection,
          label:      cleanLabel(label),
          unit:       inferUnitFromLabel(label),
          multiplier: multiplier === 1 ? undefined : multiplier,
          formula:    buildFormulaFromMultiplier(key, multiplier, inferUnitFromLabel(label)),
        };
      }
    }
  }

  return attributes;
}

// ---------------------------------------------------------------------------
// Parse Ship.cpp for derived stat formulas
//
// Looks for patterns like:
//   double Ship::MaxVelocity() const
//   {
//       return attributes.Get("thrust") / attributes.Get("drag");
//   }
//
//   double Ship::Acceleration() const
//   {
//       return (attributes.Get("thrust") + ...) / (mass);
//   }
// ---------------------------------------------------------------------------

function parseShipCpp(src) {
  const derivedStats = {};

  // Extract function bodies for known stat functions
  const knownFunctions = [
    'MaxVelocity', 'Acceleration', 'TurnRate', 'MaxReverseVelocity',
    'RampScoopRate', 'HullDamageAmount', 'ShieldDamageAmount',
    'IdleHeat', 'MaxHeat', 'HeatDissipation', 'DisabledHull',
  ];

  for (const fnName of knownFunctions) {
    // Match:  <return type> Ship::<fnName>(...) [const] \n { \n ... return <expr>; \n }
    const fnRe = new RegExp(
      `\\w[\\w:<>*& ]+\\s+Ship::${fnName}\\s*\\([^)]*\\)\\s*(?:const\\s*)?\\{([^}]+)\\}`,
      's'
    );
    const m = src.match(fnRe);
    if (m) {
      const body = m[1];
      // Find the return statement
      const retMatch = body.match(/return\s+([^;]+);/);
      if (retMatch) {
        const rawExpr = retMatch[1].trim();
        derivedStats[fnName] = {
          rawExpression: rawExpr,
          formula:       simplifyFormula(rawExpr),
          formulaDisplay: humaniseFormula(rawExpr),
        };
      }
    }
  }

  // Also scan for inline calculations that appear in ShipInfoDisplay.cpp
  // e.g.  double maxVelocity = attributes.Get("thrust") / attributes.Get("drag");
  const inlineCalcRe = /double\s+(\w+)\s*=\s*([^;]+);/g;
  let m2;
  while ((m2 = inlineCalcRe.exec(src)) !== null) {
    const [, varName, expr] = m2;
    if (!derivedStats[varName] && expr.includes('Get(')) {
      derivedStats[varName] = {
        rawExpression: expr.trim(),
        formula:       simplifyFormula(expr.trim()),
        formulaDisplay: humaniseFormula(expr.trim()),
      };
    }
  }

  return derivedStats;
}

// ---------------------------------------------------------------------------
// Parse ShipInfoDisplay.cpp for additional display-side derived stats
// ---------------------------------------------------------------------------

function parseShipInfoDisplay(src) {
  const stats = {};

  // Lines like:
  //   table.Add("Max shields:", ship.Attributes().Get("shields"));
  //   table.Add("Acceleration:", 3600. * ship.Acceleration());
  const addRe = /\.Add\s*\(\s*"([^"]+)"\s*,\s*([^)]+)\)/g;
  let m;
  while ((m = addRe.exec(src)) !== null) {
    const [, label, expr] = m;
    const key = labelToKey(label);
    if (key && !stats[key]) {
      stats[key] = {
        label:          cleanLabel(label),
        rawExpression:  expr.trim(),
        formula:        simplifyFormula(expr.trim()),
        formulaDisplay: humaniseFormula(expr.trim()),
      };
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Parse Outfit.cpp for stacking rules
//
// Most attributes stack additively. Outfit.cpp documents exceptions like:
//   "jump fuel" — uses minimum across all installed drives
//   "jump range" — uses maximum across all installed drives
// ---------------------------------------------------------------------------

function parseOutfitCpp(src) {
  const stackingRules = {};

  // Look for comments/code that describe special stacking
  // e.g.  // Jump fuel uses the minimum of all installed drives.
  //       if(key == "jump fuel") ...minimum...

  const minRe = /(?:minimum|min)\s+(?:of|across)[^;.]*["'`]([^"'`]+)["'`]/gi;
  const maxRe = /(?:maximum|max)\s+(?:of|across)[^;.]*["'`]([^"'`]+)["'`]/gi;

  let m;
  while ((m = minRe.exec(src)) !== null)
    stackingRules[m[1]] = { stacking: 'minimum', note: 'Uses the lowest value among all installed outfits.' };
  while ((m = maxRe.exec(src)) !== null)
    stackingRules[m[1]] = { stacking: 'maximum', note: 'Uses the highest value among all installed outfits.' };

  // Multiplier attributes follow stat * (1 + multiplier) pattern
  const multRe = /["'`](\w[\w ]*multiplier)["'`]/g;
  while ((m = multRe.exec(src)) !== null) {
    if (!stackingRules[m[1]]) {
      stackingRules[m[1]] = {
        stacking: 'additive-multiplier',
        formula:  'stat × (1 + sum_of_multipliers)',
        note:     'Stacks additively with other multipliers, then applied as a multiplier to the base stat.',
      };
    }
  }

  return stackingRules;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanLabel(label) {
  return label.replace(/:$/, '').replace(/\s+/g, ' ').trim();
}

function labelToKey(label) {
  return label
    .replace(/:$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function inferUnitFromLabel(label) {
  if (/\/s/i.test(label))     return '/s';
  if (/\/frame/i.test(label)) return '/frame';
  if (/energy/i.test(label))  return 'energy/frame';
  if (/heat/i.test(label))    return 'heat/frame';
  if (/fuel/i.test(label))    return 'fuel/frame';
  if (/credit/i.test(label))  return 'credits';
  if (/ton/i.test(label))     return 'tons';
  if (/px/i.test(label))      return 'px';
  if (/°/i.test(label))       return '°/s';
  return '';
}

function buildFormulaFromMultiplier(key, multiplier, unit) {
  if (!multiplier || multiplier === 1) return `${key}`;
  if (multiplier === 60)  return `${key} × 60  (per-frame → per-second)`;
  if (multiplier === -60) return `−${key} × 60  (cost, per-frame → per-second)`;
  if (multiplier === 3600) return `${key} × 3600  (per-frame² → per-second²)`;
  return `${key} × ${multiplier}`;
}

function simplifyFormula(expr) {
  // Replace C++ attribute access patterns with readable names
  return expr
    .replace(/attributes\.Get\s*\(\s*"([^"]+)"\s*\)/g, (_, k) => k.replace(/ /g, '_'))
    .replace(/ship\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g, (_, k) => k.replace(/ /g, '_'))
    .replace(/outfit\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g, (_, k) => k.replace(/ /g, '_'))
    .replace(/\s+/g, ' ')
    .trim();
}

function humaniseFormula(expr) {
  return simplifyFormula(expr)
    .replace(/_/g, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s*\*\s*/g, ' × ')
    .replace(/\s*\+\s*/g, ' + ')
    .replace(/\s*-\s*/g, ' − ')
    .trim();
}

// ---------------------------------------------------------------------------
// Hardcoded derived stat formulas
// These are well-known formulas from Ship.cpp that are stable across versions.
// The parser will supplement these with anything extracted from the live source.
// ---------------------------------------------------------------------------

const KNOWN_DERIVED_STATS = {
  maxSpeed: {
    label:          'Max Speed',
    unit:           'px/s',
    formula:        'thrust / drag',
    formulaDisplay: 'thrust / drag',
    description:    'Theoretical top speed. Thrust exactly balances drag at this velocity.',
    sourceFunction: 'Ship::MaxVelocity',
  },
  acceleration: {
    label:          'Acceleration',
    unit:           'px/s²',
    formula:        '3600 * thrust / mass',
    formulaDisplay: '3600 × thrust / mass',
    description:    'Acceleration in px/s². (thrust / mass) per frame × 60² for per-second².',
    sourceFunction: 'Ship::Acceleration',
  },
  turnRate: {
    label:          'Turn Rate',
    unit:           '°/s',
    formula:        '60 * turn / mass',
    formulaDisplay: '60 × turn / mass',
    description:    'Turn speed in degrees per second.',
    sourceFunction: 'Ship::TurnRate',
  },
  ramscoopFuelPerSecond: {
    label:          'Ramscoop Fuel/s',
    unit:           'fuel/s at 1 AU',
    formula:        '0.03 * sqrt(ramscoop)',
    formulaDisplay: '0.03 × √ramscoop',
    description:    'Fuel per second at 1 AU. Multiplied by (0.2 + 1.8 / (dist/1000 + 1)) × solar_wind.',
    sourceFunction: 'ramscoop inline',
  },
  heatCapacity: {
    label:          'Heat Capacity',
    unit:           'heat',
    formula:        '100 * (mass + heat_capacity_outfits)',
    formulaDisplay: '100 × (mass + heat capacity outfits)',
    description:    'Maximum heat before overheating.',
    sourceFunction: 'Ship::MaxHeat',
  },
  disabledHullThreshold: {
    label:          'Disabled Hull Threshold',
    unit:           'hull',
    formula:        'hull * max(0.15, min(0.45, 10 / sqrt(hull)))',
    formulaDisplay: 'hull × max(0.15, min(0.45, 10 / √hull))',
    description:    'Hull value at which the ship is disabled. Overridden by "absolute threshold" or "threshold percentage".',
    sourceFunction: 'Ship::DisabledHull',
  },
  scanEvasion: {
    label:          'Scan Evasion',
    unit:           'fraction',
    formula:        'scan_interference / (1 + scan_interference)',
    formulaDisplay: 'scan interference / (1 + scan interference)',
    description:    'Probability that a scan finds nothing illegal.',
    sourceFunction: 'inline',
  },
  cargoScanRange: {
    label:          'Cargo Scan Range',
    unit:           'px',
    formula:        '100 * sqrt(cargo_scan_power)',
    formulaDisplay: '100 × √(cargo scan power)',
    description:    'Max cargo scan range in pixels.',
    sourceFunction: 'inline',
  },
  outfitScanRange: {
    label:          'Outfit Scan Range',
    unit:           'px',
    formula:        '100 * sqrt(outfit_scan_power)',
    formulaDisplay: '100 × √(outfit scan power)',
    description:    'Max outfit scan range in pixels.',
    sourceFunction: 'inline',
  },
  tacticalScanRange: {
    label:          'Tactical Scan Range',
    unit:           'px',
    formula:        '100 * sqrt(tactical_scan_power)',
    formulaDisplay: '100 × √(tactical scan power)',
    description:    'Range for fuel/energy/heat/crew readout.',
    sourceFunction: 'inline',
  },
  asteroidScanRange: {
    label:          'Asteroid Scan Range',
    unit:           'px',
    formula:        '100 * sqrt(asteroid_scan_power)',
    formulaDisplay: '100 × √(asteroid scan power)',
    description:    'Range for targeting minable asteroids.',
    sourceFunction: 'inline',
  },
  dragReduction: {
    label:          'Effective Drag',
    unit:           '',
    formula:        'drag / (1 + drag_reduction)',
    formulaDisplay: 'drag / (1 + drag reduction)',
    description:    'Actual drag after drag reduction outfits.',
    sourceFunction: 'inline',
  },
  inertiaReduction: {
    label:          'Inertial Mass',
    unit:           'tons',
    formula:        'mass / (1 + inertia_reduction)',
    formulaDisplay: 'mass / (1 + inertia reduction)',
    description:    'Effective mass for movement calculations.',
    sourceFunction: 'inline',
  },
  damageProtection: {
    label:          'Damage Reduction Factor',
    unit:           '× incoming',
    formula:        '1 / (1 + protection)',
    formulaDisplay: '1 / (1 + protection)',
    description:    'Multiplier on incoming damage of the relevant type. 1.0 protection = half damage.',
    sourceFunction: 'inline',
  },
  coolingInefficiency: {
    label:          'Cooling Inefficiency Factor',
    unit:           '×',
    formula:        '2 + 2/(1+exp(i/-2)) - 4/(1+exp(i/-4))',
    formulaDisplay: '2 + 2/(1+e^(i/−2)) − 4/(1+e^(i/−4))',
    description:    'S-curve multiplier reducing cooling effectiveness as inefficiency rises.',
    sourceFunction: 'inline',
  },
  weaponRange: {
    label:          'Weapon Range',
    unit:           'px',
    formula:        'velocity * lifetime',
    formulaDisplay: 'velocity × lifetime',
    description:    'Max distance a projectile travels.',
    sourceFunction: 'inline',
  },
  shieldDPS: {
    label:          'Shield DPS',
    unit:           'dmg/s',
    formula:        'shield_damage / reload * 60',
    formulaDisplay: 'shield damage / reload × 60',
    description:    'Shield damage per second for a single weapon.',
    sourceFunction: 'inline',
  },
  hullDPS: {
    label:          'Hull DPS',
    unit:           'dmg/s',
    formula:        'hull_damage / reload * 60',
    formulaDisplay: 'hull damage / reload × 60',
    description:    'Hull damage per second for a single weapon.',
    sourceFunction: 'inline',
  },
  antiMissileChance: {
    label:          'Anti-Missile Intercept Chance',
    unit:           'fraction',
    formula:        'anti_missile / (anti_missile + missile_strength)',
    formulaDisplay: 'anti-missile / (anti-missile + missile strength)',
    description:    'Probability of intercepting a given missile.',
    sourceFunction: 'inline',
  },
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

async function parseAttributes(outputDir) {
  const outDir  = outputDir || path.join(process.cwd(), 'data');
  const outFile = path.join(outDir, 'attributeDefinitions.json');

  await fs.mkdir(outDir, { recursive: true });

  console.log('\n' + '='.repeat(60));
  console.log('Parsing Endless Sky attribute definitions from source...');
  console.log('='.repeat(60));

  // ── Fetch source files ───────────────────────────────────────────────────
  const sources = {};
  for (const [name, url] of Object.entries(SOURCE_FILES)) {
    try {
      console.log(`  Fetching ${url.split('/').pop()}...`);
      sources[name] = await fetchText(url);
      console.log(`  ✓ ${sources[name].length} bytes`);
    } catch (err) {
      console.warn(`  ✗ Could not fetch ${name}: ${err.message}`);
      sources[name] = '';
    }
  }

  // ── Extract data ─────────────────────────────────────────────────────────
  console.log('\n  Extracting attributes from OutfitInfoDisplay.cpp...');
  const outfitDisplayAttrs = sources.outfitInfoDisplay
    ? parseOutfitInfoDisplay(sources.outfitInfoDisplay)
    : {};
  console.log(`  → ${Object.keys(outfitDisplayAttrs).length} attributes found`);

  console.log('  Extracting derived formulas from Ship.cpp...');
  const shipFormulas = sources.ship
    ? parseShipCpp(sources.ship)
    : {};
  console.log(`  → ${Object.keys(shipFormulas).length} formulas found`);

  console.log('  Extracting display stats from ShipInfoDisplay.cpp...');
  const shipDisplayStats = sources.shipInfoDisplay
    ? parseShipInfoDisplay(sources.shipInfoDisplay)
    : {};
  console.log(`  → ${Object.keys(shipDisplayStats).length} display stats found`);

  console.log('  Extracting stacking rules from Outfit.cpp...');
  const stackingRules = sources.outfit
    ? parseOutfitCpp(sources.outfit)
    : {};
  console.log(`  → ${Object.keys(stackingRules).length} stacking rules found`);

  // ── Merge live-extracted data with known hardcoded formulas ──────────────
  // Live-extracted data from the C++ source takes precedence so the JSON
  // stays accurate as the game evolves. The hardcoded KNOWN_DERIVED_STATS
  // fill in gaps where the regex couldn't extract a clean formula.
  const derivedStats = { ...KNOWN_DERIVED_STATS };
  for (const [key, val] of Object.entries(shipFormulas)) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (!derivedStats[camel]) {
      derivedStats[camel] = { label: key, ...val };
    } else {
      // Supplement with live formula if it looks cleaner
      if (val.formula && val.formula.length < 120) {
        derivedStats[camel].liveFormula = val.formula;
        derivedStats[camel].liveFormulaDisplay = val.formulaDisplay;
      }
    }
  }

  // ── Assemble final JSON ──────────────────────────────────────────────────
  const result = {
    _source:      'https://github.com/endless-sky/endless-sky',
    _sourceFiles: Object.values(SOURCE_FILES),
    _generatedAt: new Date().toISOString(),
    _notes:       'Frames are 1/60 of a second. Attributes stack additively unless noted in stackingRules.',

    // Attribute keys as they appear in the game data files, with their
    // display label, unit, per-frame multiplier, and formula (if any).
    outfitAttributes:  outfitDisplayAttrs,

    // Derived statistics calculated from the raw attribute values.
    derivedStats,

    // Special stacking rules for attributes that don't simply add.
    stackingRules,

    // Display-side stats from ShipInfoDisplay (section headings, order).
    shipDisplayStats,
  };

  // ── Write output ─────────────────────────────────────────────────────────
  await fs.writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n  ✓ Written → ${outFile}`);
  console.log(`    ${Object.keys(result.outfitAttributes).length} outfit attributes`);
  console.log(`    ${Object.keys(result.derivedStats).length} derived stats`);
  console.log(`    ${Object.keys(result.stackingRules).length} stacking rules`);
  console.log(`    ${Object.keys(result.shipDisplayStats).length} ship display stats`);

  return result;
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  parseAttributes().catch(err => {
    console.error('attributeParser error:', err);
    process.exit(1);
  });
}

module.exports = { parseAttributes };
