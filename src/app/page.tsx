'use client';

import React, { useState } from 'react';
import { AuthAndOnboarding } from '@/components/AuthAndOnboarding';
import { SocialFeedAndFollow } from '@/components/SocialFeedAndFollow';
import { RealtimeChatAndWebRTC } from '@/components/RealtimeChatAndWebRTC';
import { UserProfile, supabase } from '@/lib/supabaseClient';
import { MessageSquare, Globe, LogOut, UserCheck } from 'lucide-react';

export default function HomePage() {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [activeTab, setActiveTab] = useState<'feed' | 'chat'>('feed');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  const handleOpenChatFromFeed = (conversationId: string) => {
    setSelectedConversationId(conversationId);
    setActiveTab('chat');
  };

  const handleSignOut = async () => {
    if (currentUser) {
      await supabase
        .from('users')
        .update({ is_online: false, last_seen: new Date().toISOString() })
        .eq('id', currentUser.id);
    }
    await supabase.auth.signOut();
    setCurrentUser(null);
  };

  return (
    <AuthAndOnboarding onAuthenticated={(profile) => setCurrentUser(profile)}>
      {currentUser && (
        <div dir="rtl" className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
          <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md">
            <div className="max-w-7xl mx-auto px-3 sm:px-4 h-16 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center font-bold text-white tracking-tight">
                  MS
                </div>
                <div>
                  <h1 className="font-bold text-base leading-none">تواصل مباشر</h1>
                  <p className="text-xs text-slate-400" dir="ltr">
                    @{currentUser.username}
                  </p>
                </div>
              </div>

              <nav className="flex items-center gap-2 bg-slate-950 p-1 rounded-xl border border-slate-800">
                <button
                  onClick={() => setActiveTab('feed')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                    activeTab === 'feed'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Globe className="w-4 h-4" />
                  <span className="hidden sm:inline">المجتمع</span>
                </button>
                <button
                  onClick={() => setActiveTab('chat')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                    activeTab === 'chat'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <MessageSquare className="w-4 h-4" />
                  <span className="hidden sm:inline">المحادثات</span>
                </button>
              </nav>

              <div className="flex items-center gap-3">
                <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/70 border border-slate-700 text-xs text-emerald-400">
                  <UserCheck className="w-3.5 h-3.5" />
                  <span>حساب موثق</span>
                </div>
                <button
                  onClick={handleSignOut}
                  className="p-2 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-rose-400 transition"
                  title="تسجيل الخروج"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          </header>

          <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-4 py-4 sm:py-6">
            {activeTab === 'feed' ? (
              <SocialFeedAndFollow
                currentUser={currentUser}
                onOpenConversation={handleOpenChatFromFeed}
              />
            ) : (
              <RealtimeChatAndWebRTC
                currentUser={currentUser}
                initialConversationId={selectedConversationId}
              />
            )}
          </main>
        </div>
      )}
    </AuthAndOnboarding>
  );
}
