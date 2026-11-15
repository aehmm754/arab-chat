'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  supabase,
  UserProfile,
  ConversationItem,
  ChatMessage,
} from '@/lib/supabaseClient';
import {
  Phone,
  Video,
  PhoneIncoming,
  PhoneOff,
  Mic,
  MicOff,
  VideoOff,
  Send,
  Image as ImageIcon,
  Film,
  Check,
  CheckCheck,
  Square,
  Loader2,
  Lock,
} from 'lucide-react';

interface RealtimeChatAndWebRTCProps {
  currentUser: UserProfile;
  initialConversationId: string | null;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

interface IncomingCallPayload {
  callerId: string;
  callerName: string;
  callerUsername: string;
  callType: 'audio' | 'video';
  sdpOffer: RTCSessionDescriptionInit;
}

export const RealtimeChatAndWebRTC: React.FC<RealtimeChatAndWebRTCProps> = ({
  currentUser,
  initialConversationId,
}) => {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState('');
  const [uploadingMedia, setUploadingMedia] = useState(false);

  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [peerTyping, setPeerTyping] = useState(false);

  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const [callState, setCallState] = useState<
    'idle' | 'calling' | 'ringing' | 'connected'
  >('idle');
  const [activeCallType, setActiveCallType] = useState<'audio' | 'video'>('video');
  const [incomingCall, setIncomingCall] = useState<IncomingCallPayload | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const callChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const activeConversation = conversations.find((c) => c.id === activeConvId) || null;
  const activePeer = activeConversation?.peer || null;

  const loadConversations = useCallback(async () => {
    const { data: convRows } = await supabase
      .from('conversations')
      .select('*')
      .or(`participant_one.eq.${currentUser.id},participant_two.eq.${currentUser.id}`)
      .order('last_message_at', { ascending: false });

    if (!convRows || convRows.length === 0) {
      setConversations([]);
      return;
    }

    const peerIds = convRows.map((c) =>
      c.participant_one === currentUser.id ? c.participant_two : c.participant_one
    );

    const { data: peers } = await supabase
      .from('users')
      .select('*')
      .in('id', peerIds);

    const peerMap: Record<string, UserProfile> = {};
    (peers || []).forEach((p) => {
      peerMap[p.id] = p as UserProfile;
    });

    const enriched: ConversationItem[] = convRows.map((c) => {
      const pid =
        c.participant_one === currentUser.id ? c.participant_two : c.participant_one;
      return {
        ...(c as ConversationItem),
        peer: peerMap[pid],
      };
    });

    setConversations(enriched);
    if (!activeConvId && enriched.length > 0) {
      setActiveConvId(enriched[0].id);
    }
  }, [currentUser.id, activeConvId]);

  useEffect(() => {
    loadConversations();

    const presenceChannel = supabase.channel('presence:global', {
      config: { presence: { key: currentUser.id } },
    });

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        const state = presenceChannel.presenceState();
        setOnlineUserIds(new Set(Object.keys(state)));
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({
            user_id: currentUser.id,
            online_at: new Date().toISOString(),
          });
        }
      });

    return () => {
      supabase.removeChannel(presenceChannel);
    };
  }, [currentUser.id, loadConversations]);

  const markMessagesDeliveredAndRead = useCallback(
    async (convId: string) => {
      const nowIso = new Date().toISOString();
      await supabase
        .from('messages')
        .update({ delivered_at: nowIso, read_at: nowIso })
        .eq('conversation_id', convId)
        .eq('receiver_id', currentUser.id)
        .is('read_at', null);
    },
    [currentUser.id]
  );

  const loadMessages = useCallback(
    async (convId: string) => {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true });

      setMessages((data || []) as ChatMessage[]);
      await markMessagesDeliveredAndRead(convId);
    },
    [markMessagesDeliveredAndRead]
  );

  const cleanupCallResources = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((track) => track.stop());
      remoteStreamRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    pendingIceCandidatesRef.current = [];
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setCallState('idle');
    setIncomingCall(null);
    setIsMicMuted(false);
    setIsCameraOff(false);
  }, []);

  useEffect(() => {
    if (!activeConvId) return;

    loadMessages(activeConvId);

    const roomChannel = supabase.channel(`call-room:${activeConvId}`, {
      config: { broadcast: { ack: true, self: false } },
    });

    roomChannel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${activeConvId}`,
        },
        async (payload) => {
          if (payload.eventType === 'INSERT') {
            const newMsg = payload.new as ChatMessage;
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
            if (newMsg.receiver_id === currentUser.id) {
              await markMessagesDeliveredAndRead(activeConvId);
            }
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as ChatMessage;
            setMessages((prev) =>
              prev.map((m) => (m.id === updated.id ? updated : m))
            );
          }
          loadConversations();
        }
      )
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload.userId !== currentUser.id) {
          setPeerTyping(Boolean(payload.isTyping));
        }
      })
      .on('broadcast', { event: 'webrtc-offer' }, ({ payload }) => {
        if (payload.targetUserId !== currentUser.id) return;
        setIncomingCall({
          callerId: payload.callerId,
          callerName: payload.callerName,
          callerUsername: payload.callerUsername,
          callType: payload.callType,
          sdpOffer: payload.sdpOffer,
        });
        setActiveCallType(payload.callType);
        setCallState('ringing');
      })
      .on('broadcast', { event: 'webrtc-answer' }, async ({ payload }) => {
        if (payload.targetUserId !== currentUser.id) return;
        const pc = peerConnectionRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdpAnswer));
        for (const candidate of pendingIceCandidatesRef.current) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingIceCandidatesRef.current = [];
        setCallState('connected');
      })
      .on('broadcast', { event: 'webrtc-ice-candidate' }, async ({ payload }) => {
        if (payload.targetUserId !== currentUser.id) return;
        const pc = peerConnectionRef.current;
        if (!pc || !payload.candidate) return;
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else {
          pendingIceCandidatesRef.current.push(payload.candidate);
        }
      })
      .on('broadcast', { event: 'webrtc-end' }, () => {
        cleanupCallResources();
      })
      .subscribe();

    callChannelRef.current = roomChannel;

    return () => {
      cleanupCallResources();
      supabase.removeChannel(roomChannel);
      callChannelRef.current = null;
    };
  }, [
    activeConvId,
    currentUser.id,
    loadMessages,
    loadConversations,
    markMessagesDeliveredAndRead,
    cleanupCallResources,
  ]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const broadcastTyping = (isTyping: boolean) => {
    if (!callChannelRef.current) return;
    callChannelRef.current.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: currentUser.id, isTyping },
    });
  };

  const handleTextChange = (value: string) => {
    setMessageText(value);
    broadcastTyping(true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      broadcastTyping(false);
    }, 1500);
  };

  const handleSendTextMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim() || !activeConvId || !activePeer) return;

    const text = messageText.trim();
    setMessageText('');
    broadcastTyping(false);

    await supabase.from('messages').insert({
      conversation_id: activeConvId,
      sender_id: currentUser.id,
      receiver_id: activePeer.id,
      message_type: 'text',
      content: text,
      delivered_at: onlineUserIds.has(activePeer.id)
        ? new Date().toISOString()
        : null,
    });
  };

  const handleMediaFileUpload = async (
    file: File,
    type: 'image' | 'video' | 'audio',
    durationSeconds?: number
  ) => {
    if (!activeConvId || !activePeer) return;
    setUploadingMedia(true);

    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';
      const path = `${currentUser.id}/${activeConvId}-${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('chat-media')
        .upload(path, file, { upsert: false });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from('chat-media')
        .getPublicUrl(path);

      await supabase.from('messages').insert({
        conversation_id: activeConvId,
        sender_id: currentUser.id,
        receiver_id: activePeer.id,
        message_type: type,
        media_url: publicUrlData.publicUrl,
        media_duration: durationSeconds || null,
        delivered_at: onlineUserIds.has(activePeer.id)
          ? new Date().toISOString()
          : null,
      });
    } finally {
      setUploadingMedia(false);
    }
  };

  const handleStartVoiceRecording = async () => {
    if (isRecordingVoice) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    recordedChunksRef.current = [];
    setRecordingSeconds(0);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      const audioBlob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
      const audioFile = new File([audioBlob], `voice-${Date.now()}.webm`, {
        type: 'audio/webm',
      });
      await handleMediaFileUpload(audioFile, 'audio', recordingSeconds);
      setIsRecordingVoice(false);
      setRecordingSeconds(0);
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setIsRecordingVoice(true);

    recordingTimerRef.current = setInterval(() => {
      setRecordingSeconds((prev) => prev + 1);
    }, 1000);
  };

  const handleStopVoiceRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const createPeerConnection = (targetUserId: string) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const remoteStream = new MediaStream();
    remoteStreamRef.current = remoteStream;

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && callChannelRef.current) {
        callChannelRef.current.send({
          type: 'broadcast',
          event: 'webrtc-ice-candidate',
          payload: {
            targetUserId,
            candidate: event.candidate.toJSON(),
          },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        cleanupCallResources();
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  };

  const handleStartCall = async (callType: 'audio' | 'video') => {
    if (!activePeer || !callChannelRef.current) return;
    setActiveCallType(callType);
    setCallState('calling');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    });
    localStreamRef.current = stream;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    const pc = createPeerConnection(activePeer.id);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await callChannelRef.current.send({
      type: 'broadcast',
      event: 'webrtc-offer',
      payload: {
        targetUserId: activePeer.id,
        callerId: currentUser.id,
        callerName: currentUser.full_name || currentUser.username,
        callerUsername: currentUser.username,
        callType,
        sdpOffer: offer,
      },
    });
  };

  const handleAcceptIncomingCall = async () => {
    if (!incomingCall || !callChannelRef.current) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: incomingCall.callType === 'video',
    });
    localStreamRef.current = stream;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    const pc = createPeerConnection(incomingCall.callerId);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    await pc.setRemoteDescription(
      new RTCSessionDescription(incomingCall.sdpOffer)
    );

    for (const candidate of pendingIceCandidatesRef.current) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    pendingIceCandidatesRef.current = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await callChannelRef.current.send({
      type: 'broadcast',
      event: 'webrtc-answer',
      payload: {
        targetUserId: incomingCall.callerId,
        sdpAnswer: answer,
      },
    });

    setCallState('connected');
  };

  const handleEndOrRejectCall = async () => {
    if (callChannelRef.current && activePeer) {
      await callChannelRef.current.send({
        type: 'broadcast',
        event: 'webrtc-end',
        payload: { targetUserId: activePeer.id },
      });
    }
    cleanupCallResources();
  };

  const handleToggleMic = () => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setIsMicMuted(!track.enabled);
    });
  };

  const handleToggleCamera = () => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setIsCameraOff(!track.enabled);
    });
  };

  return (
    <div dir="rtl" className="grid grid-cols-1 lg:grid-cols-12 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden min-h-[76vh]">
      <aside className="lg:col-span-4 border-b lg:border-b-0 lg:border-l border-slate-800 flex flex-col">
        <div className="p-4 border-b border-slate-800">
          <h2 className="text-sm font-bold text-white">
            المحادثات الخاصة المفتوحة
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            مراسلة فورية ومكالمات صوتية ومرئية عبر WebRTC
          </p>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60">
          {conversations.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400 space-y-2">
              <Lock className="w-6 h-6 text-amber-400 mx-auto" />
              <p>
                لا توجد محادثات مفتوحة حتى الآن. اقبل طلب متابعة في قسم المجتمع لفتح المحادثات والمكالمات.
              </p>
            </div>
          ) : (
            conversations.map((conv) => {
              const peer = conv.peer;
              if (!peer) return null;
              const isOnline = onlineUserIds.has(peer.id) || peer.is_online;

              return (
                <button
                  key={conv.id}
                  onClick={() => setActiveConvId(conv.id)}
                  className={`w-full p-4 flex items-center gap-3 text-right transition ${
                    activeConvId === conv.id
                      ? 'bg-indigo-600/15 border-r-4 border-indigo-500'
                      : 'hover:bg-slate-800/50'
                  }`}
                >
                  <div className="relative shrink-0">
                    <img
                      src={peer.avatar_url || ''}
                      alt={peer.username || ''}
                      className="w-11 h-11 rounded-xl object-cover bg-slate-800"
                    />
                    <span
                      className={`w-3 h-3 rounded-full absolute -bottom-0.5 -right-0.5 border-2 border-slate-900 ${
                        isOnline ? 'bg-emerald-400' : 'bg-slate-600'
                      }`}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-white truncate">
                        {peer.full_name}
                      </p>
                      <span className="text-[11px] text-slate-500">
                        {new Date(conv.last_message_at).toLocaleTimeString('ar-SY', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 truncate">
                      {conv.last_message_text || `@${peer.username}`}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="lg:col-span-8 flex flex-col relative">
        {!activeConversation || !activePeer ? (
          <div className="flex-1 flex items-center justify-center p-8 text-center text-sm text-slate-400">
            اختر محادثة من القائمة لبدء المراسلة الفورية أو إجراء مكالمة صوتية أو مرئية.
          </div>
        ) : (
          <>
            <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <img
                    src={activePeer.avatar_url || ''}
                    alt={activePeer.username || ''}
                    className="w-10 h-10 rounded-xl object-cover bg-slate-800"
                  />
                  <span
                    className={`w-2.5 h-2.5 rounded-full absolute -bottom-0.5 -right-0.5 border-2 border-slate-900 ${
                      onlineUserIds.has(activePeer.id) || activePeer.is_online
                        ? 'bg-emerald-400'
                        : 'bg-slate-600'
                    }`}
                  />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    {activePeer.full_name}
                  </h3>
                  <p className="text-xs text-slate-400">
                    {peerTyping ? (
                      <span className="text-indigo-400 font-medium">
                        يكتب الآن...
                      </span>
                    ) : onlineUserIds.has(activePeer.id) || activePeer.is_online ? (
                      <span className="text-emerald-400">متصل الآن</span>
                    ) : (
                      <span>
                        آخر ظهور {new Date(activePeer.last_seen).toLocaleString('ar-SY')}
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleStartCall('audio')}
                  disabled={callState !== 'idle'}
                  className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-indigo-500 text-slate-200 hover:text-indigo-400 transition"
                  title="مكالمة صوتية"
                >
                  <Phone className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleStartCall('video')}
                  disabled={callState !== 'idle'}
                  className="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition"
                  title="مكالمة فيديو"
                >
                  <Video className="w-4 h-4" />
                </button>
              </div>
            </div>

            {callState !== 'idle' && (
              <div className="bg-slate-950/95 border-b border-slate-800 p-4 flex flex-col gap-4">
                {callState === 'ringing' && incomingCall && (
                  <div className="flex items-center justify-between bg-indigo-950/60 border border-indigo-700/60 rounded-2xl p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white animate-pulse">
                        <PhoneIncoming className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-white">
                          مكالمة {incomingCall.callType === 'video' ? 'فيديو' : 'صوتية'} واردة
                        </p>
                        <p className="text-xs text-indigo-300">
                          {incomingCall.callerName} (@{incomingCall.callerUsername})
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleAcceptIncomingCall}
                        className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5"
                      >
                        <Phone className="w-3.5 h-3.5" />
                        <span>قبول</span>
                      </button>
                      <button
                        onClick={handleEndOrRejectCall}
                        className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white flex items-center gap-1.5"
                      >
                        <PhoneOff className="w-3.5 h-3.5" />
                        <span>رفض</span>
                      </button>
                    </div>
                  </div>
                )}

                {(callState === 'calling' || callState === 'connected') && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="relative rounded-xl overflow-hidden bg-slate-900 border border-slate-800 aspect-video flex items-center justify-center">
                        <video
                          ref={remoteVideoRef}
                          autoPlay
                          playsInline
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-slate-950/80 text-[11px] text-slate-200">
                          @{activePeer.username} ({callState === 'calling' ? 'جاري الرنين...' : 'متصل'})
                        </span>
                      </div>
                      <div className="relative rounded-xl overflow-hidden bg-slate-900 border border-slate-800 aspect-video flex items-center justify-center">
                        <video
                          ref={localVideoRef}
                          autoPlay
                          muted
                          playsInline
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-slate-950/80 text-[11px] text-slate-200">
                          أنت
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-center gap-3">
                      <button
                        onClick={handleToggleMic}
                        className={`p-3 rounded-xl border transition ${
                          isMicMuted
                            ? 'bg-amber-600/20 border-amber-500 text-amber-300'
                            : 'bg-slate-900 border-slate-700 text-white'
                        }`}
                        title="كتم / تشغيل الميكروفون"
                      >
                        {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      </button>

                      {activeCallType === 'video' && (
                        <button
                          onClick={handleToggleCamera}
                          className={`p-3 rounded-xl border transition ${
                            isCameraOff
                              ? 'bg-amber-600/20 border-amber-500 text-amber-300'
                              : 'bg-slate-900 border-slate-700 text-white'
                          }`}
                          title="إيقاف / تشغيل الكاميرا"
                        >
                          {isCameraOff ? (
                            <VideoOff className="w-4 h-4" />
                          ) : (
                            <Video className="w-4 h-4" />
                          )}
                        </button>
                      )}

                      <button
                        onClick={handleEndOrRejectCall}
                        className="px-5 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white flex items-center gap-2"
                      >
                        <PhoneOff className="w-4 h-4" />
                        <span>إنهاء المكالمة</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-950/50">
              {messages.map((msg) => {
                const isMine = msg.sender_id === currentUser.id;
                return (
                  <div
                    key={msg.id}
                    className={`flex ${isMine ? 'justify-start' : 'justify-end'}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-2xl p-3 space-y-1.5 ${
                        isMine
                          ? 'bg-indigo-600 text-white rounded-bl-none'
                          : 'bg-slate-800 text-slate-100 rounded-br-none'
                      }`}
                    >
                      {msg.message_type === 'text' && (
                        <p className="text-sm whitespace-pre-wrap break-words">
                          {msg.content}
                        </p>
                      )}

                      {msg.message_type === 'image' && msg.media_url && (
                        <img
                          src={msg.media_url}
                          alt="مرفق محادثة"
                          className="rounded-xl max-h-64 object-cover"
                        />
                      )}

                      {msg.message_type === 'video' && msg.media_url && (
                        <video
                          src={msg.media_url}
                          controls
                          className="rounded-xl max-h-64"
                        />
                      )}

                      {msg.message_type === 'audio' && msg.media_url && (
                        <div className="flex items-center gap-2">
                          <audio src={msg.media_url} controls className="h-8 max-w-[220px]" />
                          {msg.media_duration && (
                            <span className="text-[10px] opacity-80">
                              {msg.media_duration} ث
                            </span>
                          )}
                        </div>
                      )}

                      <div className="flex items-center justify-end gap-1 text-[10px] opacity-80">
                        <span>
                          {new Date(msg.created_at).toLocaleTimeString('ar-SY', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {isMine && (
                          <>
                            {msg.read_at ? (
                              <CheckCheck className="w-3.5 h-3.5 text-emerald-300" />
                            ) : msg.delivered_at ? (
                              <CheckCheck className="w-3.5 h-3.5 text-slate-300" />
                            ) : (
                              <Check className="w-3.5 h-3.5 text-slate-300" />
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <form
              onSubmit={handleSendTextMessage}
              className="p-3 border-t border-slate-800 bg-slate-900 flex items-center gap-2"
            >
              <label className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-indigo-500 cursor-pointer text-slate-300" title="إرسال صورة">
                <ImageIcon className="w-4 h-4" />
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleMediaFileUpload(f, 'image');
                  }}
                  className="hidden"
                />
              </label>

              <label className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-indigo-500 cursor-pointer text-slate-300" title="إرسال فيديو">
                <Film className="w-4 h-4" />
                <input
                  type="file"
                  accept="video/mp4,video/webm"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleMediaFileUpload(f, 'video');
                  }}
                  className="hidden"
                />
              </label>

              {!isRecordingVoice ? (
                <button
                  type="button"
                  onClick={handleStartVoiceRecording}
                  className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-rose-500 text-slate-300 hover:text-rose-400"
                  title="تسجيل رسالة صوتية"
                >
                  <Mic className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStopVoiceRecording}
                  className="px-3 py-2 rounded-xl bg-rose-600 text-white text-xs font-semibold flex items-center gap-1.5 animate-pulse"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>إيقاف ({recordingSeconds} ث)</span>
                </button>
              )}

              <input
                type="text"
                value={messageText}
                onChange={(e) => handleTextChange(e.target.value)}
                placeholder="اكتب رسالتك هنا..."
                className="flex-1 px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
              />

              <button
                type="submit"
                disabled={uploadingMedia || !messageText.trim()}
                className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5"
              >
                {uploadingMedia ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
};