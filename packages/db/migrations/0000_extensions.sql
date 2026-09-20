-- Ya creadas por packages/db/sql/bootstrap-roles.sql (que corre como
-- superusuario antes de que exista esta migración). Se vuelven a pedir acá,
-- con IF NOT EXISTS, para que la migración quede documentada en el historial
-- de Drizzle y sea inofensiva si ya existen.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;
