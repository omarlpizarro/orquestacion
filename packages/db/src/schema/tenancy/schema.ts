import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  point,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from '../../columns.js';
import { organization } from '../auth/schema.js';

/**
 * docs/data-model.md, sección "Identidad, tenancy y RBAC". `organizationId`
 * es `text` PRIMARY KEY (no lleva su propio `id`): es 1 a 1 con
 * `auth.organization`, y su clave referencia directamente la de Better Auth
 * (ADR-010).
 */
export const organizationProfile = pgTable(
  'organization_profile',
  {
    organizationId: text('organization_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    legalName: text('legal_name'),
    taxId: text('tax_id'),
    industry: text('industry').notNull(),
    timezone: text('timezone').notNull().default('America/Argentina/Buenos_Aires'),
    locale: text('locale').notNull().default('es-AR'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'organization_profile_industry_check',
      sql`${table.industry} in ('gastronomia','agro','salud','mineria','energia','construccion','eventos','otro')`,
    ),
  ],
);

export const site = pgTable(
  'site',
  {
    id: uuid('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    address: text('address'),
    geo: point('geo', { mode: 'xy' }),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [unique().on(table.organizationId, table.id)],
);

export const memberSiteAccess = pgTable(
  'member_site_access',
  {
    organizationId: text('organization_id').notNull(),
    memberId: text('member_id').notNull(),
    siteId: uuid('site_id').notNull(),
    role: text('role').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.siteId] }),
    check('member_site_access_role_check', sql`${table.role} in ('manager','operator')`),
  ],
);

export const guestLink = pgTable(
  'guest_link',
  {
    id: uuid('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    scopeKind: text('scope_kind').notNull(),
    scopeId: uuid('scope_id').notNull(),
    label: text('label'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true, mode: 'string' }),
    viewCount: integer('view_count').notNull().default(0),
    createdByMemberId: text('created_by_member_id').notNull(),
  },
  (table) => [
    check(
      'guest_link_scope_kind_check',
      sql`${table.scopeKind} in ('project','task','milestones')`,
    ),
  ],
);
