'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  supabase,
  UserProfile,
  FollowRequest,
  PostItem,
  PostComment,
} from '@/lib/supabaseClient';
import {
  Search,
  UserPlus,
  Clock,
  Check,
  X,
  MessageSquare,
  Lock,
  Globe,
  Users,
  Image as ImageIcon,
  Heart,
  MessageCircle,
  Send,
  Loader2,
} from 'lucide-react';

interface SocialFeedAndFollowProps {
  currentUser: UserProfile;
  onOpenConversation: (conversationId: string) => void;
}

export const SocialFeedAndFollow: React.FC<SocialFeedAndFollowProps> = ({
  currentUser,
  onOpenConversation,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
  const [searching, setSearching] = useState(false);

  const [followRequests, setFollowRequests] = useState<FollowRequest[]>([]);
  const [userMap, setUserMap] = useState<Record<string, UserProfile>>({});

  const [posts, setPosts] = useState<PostItem[]>([]);
  const [likedPostIds, setLikedPostIds] = useState<Set<string>>(new Set());
  const [expandedCommentsPostId, setExpandedCommentsPostId] = useState<string | null>(null);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, PostComment[]>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  const [postContent, setPostContent] = useState('');
  const [postPrivacy, setPostPrivacy] = useState<'public' | 'followers_only'>('public');
  const [postImageFile, setPostImageFile] = useState<File | null>(null);
  const [postImagePreview, setPostImagePreview] = useState<string | null>(null);
  const [publishingPost, setPublishingPost] = useState(false);

  const fetchNetworkAndFeed = useCallback(async () => {
    const [requestsRes, postsRes, likesRes] = await Promise.all([
      supabase
        .from('follow_requests')
        .select('*')
        .or(`sender_id.eq.${currentUser.id},receiver_id.eq.${currentUser.id}`)
        .order('created_at', { ascending: false }),
      supabase
        .from('posts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('post_likes')
        .select('post_id')
        .eq('user_id', currentUser.id),
    ]);

    const reqList = (requestsRes.data || []) as FollowRequest[];
    const postList = (postsRes.data || []) as PostItem[];
    setFollowRequests(reqList);
    setPosts(postList);

    if (likesRes.data) {
      setLikedPostIds(new Set(likesRes.data.map((row) => row.post_id)));
    }

    const userIds = new Set<string>([currentUser.id]);
    reqList.forEach((r) => {
      userIds.add(r.sender_id);
      userIds.add(r.receiver_id);
    });
    postList.forEach((p) => userIds.add(p.author_id));

    if (userIds.size > 0) {
      const { data: profiles } = await supabase
        .from('users')
        .select('*')
        .in('id', Array.from(userIds));

      if (profiles) {
        const mapped: Record<string, UserProfile> = {};
        profiles.forEach((prof) => {
          mapped[prof.id] = prof as UserProfile;
        });
        setUserMap((prev) => ({ ...prev, ...mapped }));
      }
    }
  }, [currentUser.id]);

  useEffect(() => {
    fetchNetworkAndFeed();

    const channel = supabase
      .channel('social-feed-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'follow_requests' },
        () => {
          fetchNetworkAndFeed();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts' },
        () => {
          fetchNetworkAndFeed();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'post_comments' },
        (payload) => {
          const postId =
            (payload.new as { post_id?: string })?.post_id ||
            (payload.old as { post_id?: string })?.post_id;
          if (postId) {
            loadCommentsForPost(postId);
          }
          fetchNetworkAndFeed();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchNetworkAndFeed]);

  useEffect(() => {
    const clean = searchQuery.trim().toLowerCase().replace(/^@/, '');
    if (!clean) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from('users')
        .select('*')
        .eq('onboarding_completed', true)
        .neq('id', currentUser.id)
        .ilike('username', `%${clean}%`)
        .limit(10);

      setSearchResults((data || []) as UserProfile[]);
      setSearching(false);
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery, currentUser.id]);

  const getRelationshipWithUser = (targetUserId: string) => {
    const match = followRequests.find(
      (r) =>
        (r.sender_id === currentUser.id && r.receiver_id === targetUserId) ||
        (r.sender_id === targetUserId && r.receiver_id === currentUser.id)
    );
    return match || null;
  };

  const handleSendFollowRequest = async (targetUserId: string) => {
    const existing = getRelationshipWithUser(targetUserId);
    if (existing) return;

    const { error } = await supabase.from('follow_requests').insert({
      sender_id: currentUser.id,
      receiver_id: targetUserId,
      status: 'pending',
    });

    if (!error) {
      await fetchNetworkAndFeed();
    }
  };

  const handleRespondFollowRequest = async (
    requestId: string,
    decision: 'accepted' | 'rejected'
  ) => {
    const { error } = await supabase
      .from('follow_requests')
      .update({ status: decision, updated_at: new Date().toISOString() })
      .eq('id', requestId);

    if (!error) {
      await fetchNetworkAndFeed();
    }
  };

  const handleOpenUnlockedChat = async (peerUserId: string) => {
    const p1 = currentUser.id < peerUserId ? currentUser.id : peerUserId;
    const p2 = currentUser.id < peerUserId ? peerUserId : currentUser.id;

    const { data: existingConv } = await supabase
      .from('conversations')
      .select('id')
      .eq('participant_one', p1)
      .eq('participant_two', p2)
      .maybeSingle();

    if (existingConv?.id) {
      onOpenConversation(existingConv.id);
      return;
    }

    const { data: createdConv } = await supabase
      .from('conversations')
      .insert({
        participant_one: p1,
        participant_two: p2,
        last_message_text: 'تم فتح المحادثة',
      })
      .select('id')
      .single();

    if (createdConv?.id) {
      onOpenConversation(createdConv.id);
    }
  };

  const handleCreatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!postContent.trim() && !postImageFile) return;

    setPublishingPost(true);
    try {
      let uploadedImageUrl: string | null = null;
      if (postImageFile) {
        const ext = postImageFile.name.split('.').pop()?.toLowerCase() || 'jpg';
        const path = `${currentUser.id}/post-${Date.now()}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from('post-media')
          .upload(path, postImageFile, { upsert: false });

        if (uploadErr) throw uploadErr;

        const { data: urlData } = supabase.storage
          .from('post-media')
          .getPublicUrl(path);
        uploadedImageUrl = urlData.publicUrl;
      }

      const { error } = await supabase.from('posts').insert({
        author_id: currentUser.id,
        content: postContent.trim(),
        image_url: uploadedImageUrl,
        privacy: postPrivacy,
      });

      if (error) throw error;

      setPostContent('');
      setPostImageFile(null);
      setPostImagePreview(null);
      await fetchNetworkAndFeed();
    } finally {
      setPublishingPost(false);
    }
  };

  const handleToggleLike = async (post: PostItem) => {
    const alreadyLiked = likedPostIds.has(post.id);
    const nextLikes = new Set(likedPostIds);

    if (alreadyLiked) {
      nextLikes.delete(post.id);
      setLikedPostIds(nextLikes);
      await supabase
        .from('post_likes')
        .delete()
        .eq('post_id', post.id)
        .eq('user_id', currentUser.id);
    } else {
      nextLikes.add(post.id);
      setLikedPostIds(nextLikes);
      await supabase.from('post_likes').insert({
        post_id: post.id,
        user_id: currentUser.id,
      });
    }

    await fetchNetworkAndFeed();
  };

  const loadCommentsForPost = async (postId: string) => {
    const { data: comments } = await supabase
      .from('post_comments')
      .select('*')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });

    if (!comments) return;

    const commenterIds = Array.from(new Set(comments.map((c) => c.user_id)));
    if (commenterIds.length > 0) {
      const { data: profiles } = await supabase
        .from('users')
        .select('*')
        .in('id', commenterIds);

      if (profiles) {
        const additions: Record<string, UserProfile> = {};
        profiles.forEach((p) => {
          additions[p.id] = p as UserProfile;
        });
        setUserMap((prev) => ({ ...prev, ...additions }));
      }
    }

    setCommentsByPost((prev) => ({
      ...prev,
      [postId]: comments as PostComment[],
    }));
  };

  const handleToggleComments = async (postId: string) => {
    if (expandedCommentsPostId === postId) {
      setExpandedCommentsPostId(null);
      return;
    }
    setExpandedCommentsPostId(postId);
    await loadCommentsForPost(postId);
  };

  const handleAddComment = async (postId: string) => {
    const text = (commentDrafts[postId] || '').trim();
    if (!text) return;

    setCommentDrafts((prev) => ({ ...prev, [postId]: '' }));
    const { error } = await supabase.from('post_comments').insert({
      post_id: postId,
      user_id: currentUser.id,
      content: text,
    });

    if (!error) {
      await loadCommentsForPost(postId);
      await fetchNetworkAndFeed();
    }
  };

  const incomingPendingRequests = followRequests.filter(
    (r) => r.receiver_id === currentUser.id && r.status === 'pending'
  );

  const acceptedConnections = followRequests.filter((r) => r.status === 'accepted');

  return (
    <div dir="rtl" className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-4 space-y-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="text-sm font-bold text-white mb-3">
            البحث عن المستخدمين عبر المعرف @Username
          </h2>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute right-3.5 top-3" />
            <input
              type="text"
              dir="ltr"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="@username"
              className="w-full pr-10 pl-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500 text-left"
            />
          </div>

          {searching && (
            <div className="py-4 flex items-center justify-center text-xs text-slate-400 gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>جاري البحث...</span>
            </div>
          )}

          {searchResults.length > 0 && (
            <div className="mt-4 space-y-2.5">
              {searchResults.map((user) => {
                const rel = getRelationshipWithUser(user.id);
                return (
                  <div
                    key={user.id}
                    className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <img
                        src={user.avatar_url || ''}
                        alt={user.username || 'User'}
                        className="w-10 h-10 rounded-xl object-cover bg-slate-800 shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white truncate">
                          {user.full_name}
                        </p>
                        <p className="text-xs text-slate-400 truncate" dir="ltr">
                          @{user.username}
                        </p>
                      </div>
                    </div>

                    {!rel && (
                      <button
                        onClick={() => handleSendFollowRequest(user.id)}
                        className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white flex items-center gap-1.5 shrink-0"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>متابعة</span>
                      </button>
                    )}

                    {rel?.status === 'pending' && (
                      <span className="px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-1 shrink-0">
                        <Clock className="w-3.5 h-3.5" />
                        <span>قيد الانتظار</span>
                      </span>
                    )}

                    {rel?.status === 'accepted' && (
                      <button
                        onClick={() => handleOpenUnlockedChat(user.id)}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 shrink-0"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>مراسلة</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-white">
              طلبات المتابعة الواردة
            </h2>
            <span className="px-2 py-0.5 text-xs rounded-full bg-indigo-600/20 text-indigo-400 font-semibold">
              {incomingPendingRequests.length}
            </span>
          </div>

          {incomingPendingRequests.length === 0 ? (
            <p className="text-xs text-slate-400">
              لا توجد طلبات متابعة معلقة حالياً.
            </p>
          ) : (
            <div className="space-y-3">
              {incomingPendingRequests.map((req) => {
                const sender = userMap[req.sender_id];
                return (
                  <div
                    key={req.id}
                    className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img
                        src={sender?.avatar_url || ''}
                        alt={sender?.username || 'user'}
                        className="w-9 h-9 rounded-xl object-cover bg-slate-800"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white truncate">
                          {sender?.full_name || 'مستخدم'}
                        </p>
                        <p className="text-xs text-slate-400 truncate" dir="ltr">
                          @{sender?.username}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleRespondFollowRequest(req.id, 'accepted')}
                        className="p-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white"
                        title="قبول وفتح المحادثة"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleRespondFollowRequest(req.id, 'rejected')}
                        className="p-2 rounded-lg bg-rose-600/20 hover:bg-rose-600/40 text-rose-300"
                        title="رفض"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="text-sm font-bold text-white mb-3">
            جهات الاتصال المفتوحة ({acceptedConnections.length})
          </h2>
          {acceptedConnections.length === 0 ? (
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-400 flex items-start gap-2.5">
              <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                المحادثات الخاصة والمكالمات الصوتية والمرئية مقفلة تماماً حتى يتم قبول طلب المتابعة بين الطرفين.
              </span>
            </div>
          ) : (
            <div className="space-y-2.5">
              {acceptedConnections.map((conn) => {
                const peerId =
                  conn.sender_id === currentUser.id ? conn.receiver_id : conn.sender_id;
                const peer = userMap[peerId];
                if (!peer) return null;

                return (
                  <div
                    key={conn.id}
                    className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="relative">
                        <img
                          src={peer.avatar_url || ''}
                          alt={peer.username || ''}
                          className="w-9 h-9 rounded-xl object-cover bg-slate-800"
                        />
                        <span
                          className={`w-2.5 h-2.5 rounded-full absolute -bottom-0.5 -right-0.5 border-2 border-slate-950 ${
                            peer.is_online ? 'bg-emerald-400' : 'bg-slate-600'
                          }`}
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white truncate">
                          {peer.full_name}
                        </p>
                        <p className="text-xs text-slate-400 truncate" dir="ltr">
                          @{peer.username}
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={() => handleOpenUnlockedChat(peer.id)}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white flex items-center gap-1.5"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>مراسلة</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-8 space-y-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <form onSubmit={handleCreatePost} className="space-y-4">
            <div className="flex items-start gap-3">
              <img
                src={currentUser.avatar_url || ''}
                alt={currentUser.username || ''}
                className="w-10 h-10 rounded-xl object-cover bg-slate-800 shrink-0"
              />
              <textarea
                rows={3}
                value={postContent}
                onChange={(e) => setPostContent(e.target.value)}
                placeholder="شارك منشوراً جديداً مع المجتمع..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
              />
            </div>

            {postImagePreview && (
              <div className="relative rounded-xl overflow-hidden border border-slate-800 max-h-72">
                <img
                  src={postImagePreview}
                  alt="مرفق المنشور"
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => {
                    setPostImageFile(null);
                    setPostImagePreview(null);
                  }}
                  className="absolute top-2 left-2 p-1.5 rounded-lg bg-slate-950/80 text-slate-200 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
              <div className="flex items-center gap-3">
                <label className="cursor-pointer px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 hover:border-indigo-500 text-xs text-slate-300 flex items-center gap-1.5">
                  <ImageIcon className="w-4 h-4 text-indigo-400" />
                  <span>إرفاق صورة</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setPostImageFile(f);
                        setPostImagePreview(URL.createObjectURL(f));
                      }
                    }}
                    className="hidden"
                  />
                </label>

                <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setPostPrivacy('public')}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition ${
                      postPrivacy === 'public'
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Globe className="w-3.5 h-3.5" />
                    <span>عام للجميع</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPostPrivacy('followers_only')}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition ${
                      postPrivacy === 'followers_only'
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5" />
                    <span>للمتابعين فقط</span>
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={publishingPost || (!postContent.trim() && !postImageFile)}
                className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-2 transition"
              >
                {publishingPost ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>نشر</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        <div className="space-y-4">
          {posts.map((post) => {
            const author = userMap[post.author_id];
            const isLiked = likedPostIds.has(post.id);
            const comments = commentsByPost[post.id] || [];

            return (
              <article
                key={post.id}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <img
                      src={author?.avatar_url || ''}
                      alt={author?.username || ''}
                      className="w-10 h-10 rounded-xl object-cover bg-slate-800"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-white">
                          {author?.full_name || 'مستخدم'}
                        </span>
                        <span className="text-xs text-slate-400" dir="ltr">
                          @{author?.username}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500">
                        {new Date(post.created_at).toLocaleString('ar-SY')}
                      </p>
                    </div>
                  </div>

                  <span
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1 border ${
                      post.privacy === 'public'
                        ? 'bg-slate-950 border-slate-800 text-slate-300'
                        : 'bg-indigo-950/60 border-indigo-800/60 text-indigo-300'
                    }`}
                  >
                    {post.privacy === 'public' ? (
                      <>
                        <Globe className="w-3 h-3" />
                        <span>عام</span>
                      </>
                    ) : (
                      <>
                        <Users className="w-3 h-3" />
                        <span>للمتابعين فقط</span>
                      </>
                    )}
                  </span>
                </div>

                {post.content && (
                  <p className="text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">
                    {post.content}
                  </p>
                )}

                {post.image_url && (
                  <div className="rounded-xl overflow-hidden border border-slate-800 max-h-96">
                    <img
                      src={post.image_url}
                      alt="صورة المنشور"
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}

                <div className="flex items-center gap-6 pt-2 border-t border-slate-800 text-xs text-slate-400">
                  <button
                    onClick={() => handleToggleLike(post)}
                    className={`flex items-center gap-1.5 font-medium transition ${
                      isLiked ? 'text-rose-400' : 'hover:text-white'
                    }`}
                  >
                    <Heart
                      className={`w-4 h-4 ${isLiked ? 'fill-rose-400 text-rose-400' : ''}`}
                    />
                    <span>{post.likes_count} إعجاب</span>
                  </button>

                  <button
                    onClick={() => handleToggleComments(post.id)}
                    className="flex items-center gap-1.5 font-medium hover:text-white transition"
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span>{post.comments_count} تعليق</span>
                  </button>
                </div>

                {expandedCommentsPostId === post.id && (
                  <div className="pt-3 border-t border-slate-800/80 space-y-3">
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {comments.map((c) => {
                        const commenter = userMap[c.user_id];
                        return (
                          <div
                            key={c.id}
                            className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-start gap-2.5"
                          >
                            <img
                              src={commenter?.avatar_url || ''}
                              alt={commenter?.username || ''}
                              className="w-7 h-7 rounded-lg object-cover bg-slate-800 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-white">
                                  {commenter?.full_name || 'مستخدم'}
                                </span>
                                <span className="text-[11px] text-slate-500" dir="ltr">
                                  @{commenter?.username}
                                </span>
                              </div>
                              <p className="text-xs text-slate-200 mt-0.5">{c.content}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={commentDrafts[post.id] || ''}
                        onChange={(e) =>
                          setCommentDrafts((prev) => ({
                            ...prev,
                            [post.id]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddComment(post.id);
                          }
                        }}
                        placeholder="اكتب تعليقاً..."
                        className="flex-1 px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        type="button"
                        onClick={() => handleAddComment(post.id)}
                        className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
                      >
                        إرسال
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
};