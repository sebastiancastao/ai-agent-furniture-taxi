import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Server-only client with service role key (full DB access, no RLS)
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// Re-export canonical types from the schema module so callers can import
// everything from one place: `import { supabase, HybridSearchResult } from "@/lib/supabase"`
export type {
  DocumentRow as Document,
  ChunkRow as DocumentChunk,
  HybridSearchRow as HybridSearchResult,
  SemanticSearchRow as SemanticSearchResult,
  DocumentStatRow,
} from "./rag/schema";
