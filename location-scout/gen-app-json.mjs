#!/usr/bin/env node
// Emits app.json. The locations index set is DERIVED from LOCATION_FILTERS below —
// the same declaration index.html reads to build its filter bar — so the two cannot drift.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));

// Canonical filter order. Every KQL query the UI builds emits its clauses in THIS order,
// and we generate an index for every non-empty subset, so any combination of dropdowns
// has a matching index. 4 filters -> 15 indexes (4 single + 11 compound).
export const LOCATION_FILTERS = ['Status', 'Category', 'Region', 'Setting'];

function subsets(arr) {
  const out = [];
  for (let mask = 1; mask < (1 << arr.length); mask++) {
    const s = [];
    for (let i = 0; i < arr.length; i++) if (mask & (1 << i)) s.push(arr[i]);
    out.push(s);
  }
  return out.sort((a, b) => a.length - b.length);
}

const locSubsets = subsets(LOCATION_FILTERS);
const locSingle = locSubsets.filter(s => s.length === 1).map(s => `values[${s[0]}]`);
const locCompound = locSubsets.filter(s => s.length > 1).map(s => s.map(f => `values[${f}]`));

const t = (name, extra = {}) => ({ name, ...extra });

const app = {
  name: 'Location Scout MN',
  slug: 'location-scout',
  description: 'Minnesota location scouting for film and commercial production — location catalog with photos, contacts, scout reports, permits and shoot-day holds.',
  category: 'Media & Production',
  icon: 'fa-map-marked-alt',
  color: '#1B7F79',
  forms: [
    {
      slug: 'projects',
      name: 'Projects',
      submissionLabelExpression: '${values("Project Code")} — ${values("Project Title")}',
      fields: [
        t('Project Code', { required: true }), t('Project Title', { required: true }),
        t('Production Type'), t('Client'), t('Production Company'), t('Director'), t('Producer'),
        t('Status', { required: true }), t('Shoot Start'), t('Shoot End'),
        t('Budget Tier'), t('Location Budget'), t('Union Status'),
        t('Notes', { rows: 3 }),
      ],
      indexes: {
        single: ['values[Project Code]', 'values[Status]', 'values[Production Type]', 'values[Shoot Start]'],
        compound: [['values[Status]', 'values[Production Type]']],
      },
    },
    {
      slug: 'locations',
      name: 'Locations',
      submissionLabelExpression: '${values("Location Code")} — ${values("Location Name")}',
      fields: [
        // Identity
        t('Location Code', { required: true }), t('Location Name', { required: true }), t('Status', { required: true }),
        // Geography
        t('Address'), t('City'), t('County'), t('Region', { required: true }), t('Zip'),
        t('Latitude'), t('Longitude'),
        // Classification
        t('Category', { required: true }), t('Sub Type'), t('Setting'), t('Period Look'),
        // Production attributes
        t('Square Footage'), t('Ceiling Height Ft'), t('Max Crew Size'), t('Parking Spaces'),
        t('Base Camp Capacity'), t('Power Access'), t('Cell Signal'), t('Noise Concerns'),
        t('Restrooms'), t('ADA Accessible'), t('Best Light'), t('Seasonal Access'),
        t('Nearest Hospital'), t('Nearest Hospital Miles'), t('Load In Notes', { rows: 2 }),
        // Commercial
        t('Day Rate'), t('Fee Structure'), t('Permit Jurisdiction'), t('Insurance Required'),
        // Meta
        t('Features'), t('Description', { rows: 3 }), t('Discovered By'), t('Discovered On'),
        t('Primary Contact Code'),
      ],
      indexes: {
        single: [...locSingle, 'values[Location Code]', 'values[City]', 'values[Period Look]'],
        compound: locCompound,
      },
    },
    {
      slug: 'location-photos',
      name: 'Location Photos',
      submissionLabelExpression: '${values("Photo Code")} — ${values("Caption")}',
      fields: [
        t('Photo Code', { required: true }), t('Location Code', { required: true }),
        t('Caption'), t('Shot Type'), t('Setting'), t('Time Of Day'), t('Season'),
        t('Photographer'), t('Captured On'), t('Lens Notes'),
        // The actual image bytes. renderType "attachment" -> dataType "file" on the form.
        { name: 'Photo', renderType: 'attachment', allowMultiple: false },
        t('Notes', { rows: 2 }),
      ],
      indexes: {
        single: ['values[Location Code]', 'values[Shot Type]', 'values[Season]', 'values[Photo Code]'],
        compound: [
          ['values[Location Code]', 'values[Shot Type]'],
          ['values[Location Code]', 'values[Season]'],
        ],
      },
    },
    {
      slug: 'contacts',
      name: 'Contacts',
      submissionLabelExpression: '${values("Full Name")} — ${values("Role")}',
      fields: [
        t('Contact Code', { required: true }), t('Full Name', { required: true }), t('Role', { required: true }),
        t('Organization'), t('Email'), t('Phone'), t('Preferred Contact'),
        t('Location Code'), t('City'), t('Region'), t('Best Time To Reach'),
        t('Status', { required: true }), t('Notes', { rows: 2 }),
      ],
      indexes: {
        single: ['values[Contact Code]', 'values[Location Code]', 'values[Role]', 'values[Status]', 'values[Region]'],
        compound: [
          ['values[Location Code]', 'values[Role]'],
          ['values[Status]', 'values[Role]'],
          ['values[Region]', 'values[Role]'],
        ],
      },
    },
    {
      slug: 'scout-reports',
      name: 'Scout Reports',
      submissionLabelExpression: '${values("Report Code")} — ${values("Location Code")}',
      fields: [
        t('Report Code', { required: true }), t('Location Code', { required: true }), t('Project Code'),
        t('Scout Name'), t('Visit Date'), t('Status', { required: true }), t('Recommendation'),
        t('Weather Conditions'), t('Sun Notes', { rows: 2 }), t('Sound Notes', { rows: 2 }),
        t('Access Notes', { rows: 2 }), t('Power Notes', { rows: 2 }), t('Crew Fit Notes', { rows: 2 }),
        t('Risks', { rows: 2 }), t('Estimated Prep Days'), t('Overall Score'),
        t('Reviewed By'), t('Reviewed On'), t('Summary', { rows: 3 }),
      ],
      indexes: {
        single: ['values[Report Code]', 'values[Location Code]', 'values[Project Code]', 'values[Status]', 'values[Recommendation]'],
        compound: [
          ['values[Status]', 'values[Recommendation]'],
          ['values[Project Code]', 'values[Status]'],
          ['values[Location Code]', 'values[Status]'],
        ],
      },
    },
    {
      slug: 'permits',
      name: 'Permits',
      submissionLabelExpression: '${values("Permit Code")} — ${values("Permit Type")}',
      fields: [
        t('Permit Code', { required: true }), t('Location Code', { required: true }), t('Project Code'),
        t('Permit Type', { required: true }), t('Jurisdiction'), t('Status', { required: true }),
        t('Applied On'), t('Issued On'), t('Expires On'), t('Fee'),
        t('Insurance Certificate'), t('Contact Code'), t('Conditions', { rows: 2 }), t('Notes', { rows: 2 }),
      ],
      indexes: {
        single: ['values[Permit Code]', 'values[Location Code]', 'values[Project Code]', 'values[Status]', 'values[Permit Type]'],
        compound: [
          ['values[Status]', 'values[Permit Type]'],
          ['values[Project Code]', 'values[Status]'],
          ['values[Location Code]', 'values[Status]'],
        ],
      },
    },
    {
      slug: 'holds',
      name: 'Holds',
      submissionLabelExpression: '${values("Hold Code")} — ${values("Location Code")}',
      fields: [
        t('Hold Code', { required: true }), t('Location Code', { required: true }), t('Project Code'),
        t('Status', { required: true }), t('Hold Type'), t('Start Date'), t('End Date'),
        t('Crew Size'), t('Day Rate Quoted'), t('Contact Code'),
        t('Requested By'), t('Requested On'), t('Notes', { rows: 2 }),
      ],
      indexes: {
        single: ['values[Hold Code]', 'values[Location Code]', 'values[Project Code]', 'values[Status]', 'values[Start Date]'],
        compound: [
          ['values[Location Code]', 'values[Status]'],
          ['values[Project Code]', 'values[Status]'],
          ['values[Status]', 'values[Hold Type]'],
        ],
      },
    },
  ],
};

fs.writeFileSync(path.join(__dir, 'app.json'), JSON.stringify(app, null, 2) + '\n');
const totals = app.forms.map(f => `${f.slug}: ${f.fields.length} fields, ${(f.indexes.single||[]).length + (f.indexes.compound||[]).length} custom indexes`);
console.log('Wrote app.json');
console.log(totals.join('\n'));
