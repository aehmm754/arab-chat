import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: {
      eventsPerSecond: 40,
    },
  },
});

export interface UserProfile {
  id: string;
  email: string;
  username: string | null;
  full_name: string | null;
  date_of_birth: string | null;
  avatar_url: string | null;
  onboarding_completed: boolean;
  is_online: boolean;
  last_seen: string;
  created_at: string;
}

export interface FollowRequest {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  sender?: UserProfile;
  receiver?: UserProfile;
}

export interface PostItem {
  id: string;
  author_id: string;
  content: string;
  image_url: string | null;
  privacy: 'public' | 'followers_only';
  likes_count: number;
  comments_count: number;
  created_at: string;
  author?: UserProfile;
}

export interface PostComment {
  id: string;
  post_id: string;
  user_id: string;
  content: string;
  created_at: string;
  user?: UserProfile;
}

export interface ConversationItem {
  id: string;
  participant_one: string;
  participant_two: string;
  last_message_text: string | null;
  last_message_at: string;
  peer?: UserProfile;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  receiver_id: string;
  message_type: 'text' | 'image' | 'video' | 'audio';
  content: string | null;
  media_url: string | null;
  media_duration: number | null;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
}
