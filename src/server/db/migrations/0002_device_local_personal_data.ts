import type { Kysely } from 'kysely';

// Revised requirements: favourites, statuses, notes, bookings, plans, clash reviews,
// "fewer like this" feedback and Ibiza stays now live on each device (browser storage),
// not on the server. The old tables are renamed (not dropped) so any data already in
// them is preserved and can be exported manually if ever needed.
//
// New: priority_events — event ids a device has marked Going/Booked and chosen to share,
// so weekly verification can check those listings first. No notes or booking details.
const RENAMED = ['user_event_state', 'bookings', 'personal_plans', 'clash_reviews', 'feedback', 'ibiza_stays'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  for (const t of RENAMED) await db.schema.alterTable(t).renameTo(`legacy_${t}`).execute();
  await db.schema
    .createTable('priority_events')
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('priority_events_pk', ['device_id', 'event_id'])
    .execute();
  await db.schema.createIndex('priority_events_event_idx').on('priority_events').column('event_id').execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('priority_events').ifExists().execute();
  for (const t of RENAMED) await db.schema.alterTable(`legacy_${t}`).renameTo(t).execute();
}
