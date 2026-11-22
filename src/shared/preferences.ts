import { z } from 'zod';
import { FEED_TYPES } from './taxonomy';

const weight = z.number().int().min(-3).max(3);

export const preferencesSchema = z.object({
  planningTimezone: z.string().default('Europe/Bratislava'),
  homeHub: z.string().default('bratislava'),
  defaultHubs: z.array(z.string()).default(['bratislava', 'vienna', 'budapest', 'prague']),
  includeNearby: z.boolean().default(true),
  nearbyRadiusKm: z.number().min(5).max(200).default(40),
  festivalNearbyRadiusKm: z.number().min(50).max(800).default(250),
  /** -3 (avoid) … 3 (love). Missing = neutral. */
  categoryWeights: z.record(z.string(), weight).default({}),
  genreWeights: z.record(z.string(), weight).default({}),
  preferEnglishFriendly: z.boolean().default(true),
  spokenLanguages: z.array(z.string()).default(['en']),
  highlightThreshold: z.number().min(0).max(100).default(55),
  notifications: z
    .object({
      inApp: z.record(z.string(), z.boolean()).default({}),
      email: z
        .object({
          enabled: z.boolean().default(false),
          address: z.email().nullable().default(null),
          mode: z.enum(['immediate', 'daily']).default('daily'),
          dailyTime: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
          types: z.array(z.enum(FEED_TYPES)).default([...FEED_TYPES]),
        })
        .default({ enabled: false, address: null, mode: 'daily', dailyTime: '08:00', types: [...FEED_TYPES] }),
    })
    .default({
      inApp: {},
      email: { enabled: false, address: null, mode: 'daily', dailyTime: '08:00', types: [...FEED_TYPES] },
    }),
  schedule: z
    .object({
      discoveryEnabled: z.boolean().default(true),
      discoveryTime: z.string().regex(/^\d{2}:\d{2}$/).default('05:30'),
      verificationEnabled: z.boolean().default(true),
      verificationWeekday: z.number().int().min(1).max(7).default(1),
      verificationTime: z.string().regex(/^\d{2}:\d{2}$/).default('06:30'),
    })
    .default({ discoveryEnabled: true, discoveryTime: '05:30', verificationEnabled: true, verificationWeekday: 1, verificationTime: '06:30' }),
});

export type Preferences = z.infer<typeof preferencesSchema>;

/** Starting interests: electronic music first, as requested. */
export const DEFAULT_PREFERENCES: Preferences = preferencesSchema.parse({
  categoryWeights: {
    dnb: 3,
    techno: 3,
    house: 3,
    trance: 1,
    electronic: 2,
    'music-festival': 2,
    concert: 1,
    rock: 0,
    'food-drink': 1,
    wine: 1,
    'christmas-market': 1,
    'design-market': 1,
    'vintage-market': 1,
    'light-festival': 1,
    'english-comedy': 2,
    boxing: 2,
    mma: 2,
    hike: 1,
  },
  genreWeights: {
    dnb: 3,
    'liquid-dnb': 3,
    'dancefloor-dnb': 3,
    neurofunk: 2,
    techno: 3,
    'melodic-techno': 3,
    house: 3,
    'afro-house': 2,
    'organic-house': 2,
    'deep-house': 2,
    breakbeat: 2,
    downtempo: 2,
    trance: 1,
  },
});
