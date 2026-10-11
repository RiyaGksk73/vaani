/**
 * Database types.
 *
 * Hand-maintained to match supabase/migrations. After changing a migration,
 * regenerate rather than editing by hand:
 *
 *   supabase gen types typescript --local > src/lib/supabase/database.types.ts
 */

export type OrgRole = "owner" | "editor" | "reviewer" | "viewer";
export type TranslationStatus = "pending" | "machine" | "edited" | "approved" | "failed";
export type TranslationOrigin = "machine" | "human";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobItemStatus = "queued" | "running" | "done" | "failed" | "skipped";

export type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
};

export type Organization = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};

export type OrgMember = {
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: string;
};

export type Book = {
  id: string;
  org_id: string;
  title: string;
  source_language: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Episode = {
  id: string;
  book_id: string;
  org_id: string;
  number: number;
  title: string;
  created_at: string;
  updated_at: string;
};

export type ScriptRow = {
  id: number;
  episode_id: string;
  org_id: string;
  row_index: number;
  character_name: string | null;
  source_text: string;
  notes: string | null;
  created_at: string;
};

export type Translation = {
  id: number;
  script_row_id: number;
  org_id: string;
  target_language: string;
  translated_text: string | null;
  status: TranslationStatus;
  origin: TranslationOrigin;
  provider: string | null;
  model: string | null;
  tm_hit: boolean;
  attempts: number;
  error: string | null;
  translated_at: string | null;
  edited_by: string | null;
  updated_at: string;
};

export type TranslationMemoryRow = {
  id: number;
  org_id: string;
  source_hash: string;
  source_text: string;
  source_language: string;
  target_language: string;
  translated_text: string;
  origin: TranslationOrigin;
  use_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type TranslationJob = {
  id: string;
  org_id: string;
  episode_id: string;
  target_language: string;
  status: JobStatus;
  total_rows: number;
  completed_rows: number;
  failed_rows: number;
  tm_hits: number;
  error: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type TranslationJobItem = {
  id: number;
  job_id: string;
  script_row_id: number;
  status: JobItemStatus;
  attempts: number;
  last_error: string | null;
  locked_at: string | null;
  locked_by: string | null;
};

export type ClaimedJobItem = {
  script_row_id: number;
  row_index: number;
  character_name: string | null;
  source_text: string;
  notes: string | null;
  attempts: number;
};

export type ScriptRowSearchResult = {
  id: number;
  episode_id: string;
  row_index: number;
  character_name: string | null;
  source_text: string;
  translation_id: number | null;
  translated_text: string | null;
  status: TranslationStatus;
  error: string | null;
};

export type EpisodeProgress = {
  total: number;
  pending: number;
  machine: number;
  edited: number;
  approved: number;
  failed: number;
};

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: Table<Profile, Pick<Profile, "id" | "email"> & Partial<Profile>>;
      organizations: Table<Organization, Pick<Organization, "name" | "slug"> & Partial<Organization>>;
      org_members: Table<OrgMember, Pick<OrgMember, "org_id" | "user_id"> & Partial<OrgMember>>;
      books: Table<Book, Pick<Book, "org_id" | "title" | "source_language"> & Partial<Book>>;
      episodes: Table<Episode, Pick<Episode, "book_id" | "org_id" | "number" | "title"> & Partial<Episode>>;
      script_rows: Table<
        ScriptRow,
        Pick<ScriptRow, "episode_id" | "org_id" | "row_index" | "source_text"> & Partial<ScriptRow>
      >;
      translations: Table<
        Translation,
        Pick<Translation, "script_row_id" | "org_id" | "target_language"> & Partial<Translation>
      >;
      translation_memory: Table<
        TranslationMemoryRow,
        Pick<
          TranslationMemoryRow,
          | "org_id"
          | "source_hash"
          | "source_text"
          | "source_language"
          | "target_language"
          | "translated_text"
        > &
          Partial<TranslationMemoryRow>
      >;
      translation_jobs: Table<
        TranslationJob,
        Pick<TranslationJob, "org_id" | "episode_id" | "target_language"> & Partial<TranslationJob>
      >;
      translation_job_items: Table<
        TranslationJobItem,
        Pick<TranslationJobItem, "job_id" | "script_row_id"> & Partial<TranslationJobItem>
      >;
    };
    Views: Record<string, never>;
    Functions: {
      enqueue_translation_job: {
        Args: { p_episode_id: string; p_target_language: string; p_retranslate?: boolean };
        Returns: string;
      };
      claim_job_items: {
        Args: { p_job_id: string; p_limit: number; p_worker: string };
        Returns: ClaimedJobItem[];
      };
      mark_job_items: {
        Args: {
          p_job_id: string;
          p_row_ids: number[];
          p_status: JobItemStatus;
          p_error?: string | null;
        };
        Returns: TranslationJob;
      };
      requeue_stuck_job_items: {
        Args: { p_older_than?: string; p_max_attempts?: number };
        Returns: number;
      };
      next_runnable_job: { Args: Record<string, never>; Returns: string | null };
      search_script_rows: {
        Args: {
          p_org_id: string;
          p_query?: string | null;
          p_episode_id?: string | null;
          p_book_id?: string | null;
          p_target_language?: string | null;
          p_limit?: number;
          p_after?: number;
        };
        Returns: ScriptRowSearchResult[];
      };
      episode_translation_progress: {
        Args: { p_episode_id: string; p_target_language: string };
        Returns: EpisodeProgress[];
      };
      save_translation_correction: {
        Args: {
          p_translation_id: number;
          p_text: string;
          p_source_hash: string;
          p_approve?: boolean;
        };
        Returns: Translation;
      };
      upsert_translation_memory: {
        Args: {
          p_org_id: string;
          p_source_hash: string;
          p_source_text: string;
          p_source_language: string;
          p_target_language: string;
          p_translated_text: string;
          p_origin?: TranslationOrigin;
        };
        Returns: void;
      };
      apply_translation_results: {
        Args: { p_org_id: string; p_target_language: string; p_results: unknown };
        Returns: number;
      };
      bump_translation_memory_usage: { Args: { p_ids: number[] }; Returns: void };
    };
    Enums: {
      org_role: OrgRole;
      translation_status: TranslationStatus;
      translation_origin: TranslationOrigin;
      job_status: JobStatus;
      job_item_status: JobItemStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};
