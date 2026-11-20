-- ===========================================================================
-- Vaani - book metadata for the dashboard
--
-- The books dashboard searches by author and filters by catalogue category
-- (Literature, Westland, Comics). Both are optional: existing books keep
-- working and simply show no author and no category until someone sets them.
--
-- Safe to run more than once.
-- ===========================================================================

alter table books add column if not exists author text;
alter table books add column if not exists category text;

alter table books drop constraint if exists books_category_check;
alter table books add constraint books_category_check
  check (category is null or category in ('literature', 'westland', 'comics'));

create index if not exists books_author_trgm_idx on books using gin (author gin_trgm_ops);
create index if not exists books_org_category_idx on books (org_id, category, created_at desc);
