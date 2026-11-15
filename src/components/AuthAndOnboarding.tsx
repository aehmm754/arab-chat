'use client';

import React, { useState, useEffect, useRef } from 'react';
import { supabase, UserProfile } from '@/lib/supabaseClient';
import {
  Mail,
  Lock,
  ShieldCheck,
  User,
  Calendar,
  AtSign,
  Upload,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowLeft,
  RefreshCw,
} from 'lucide-react';

interface AuthAndOnboardingProps {
  children: React.ReactNode;
  onAuthenticated: (profile: UserProfile) => void;
}

type AuthStep = 'loading' | 'auth' | 'verify_otp' | 'onboarding' | 'ready';

export const AuthAndOnboarding: React.FC<AuthAndOnboardingProps> = ({
  children,
  onAuthenticated,
}) => {
  const [step, setStep] = useState<AuthStep>('loading');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [resendCooldown, setResendCooldown] = useState(0);

  const [userId, setUserId] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [username, setUsername] = useState('');
  const [usernameStatus, setUsernameStatus] = useState<
    'idle' | 'checking' | 'available' | 'taken' | 'invalid'
  >('idle');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    let mounted = true;

    const inspectSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mounted) return;

      if (!session?.user) {
        setStep('auth');
        return;
      }

      setEmail(session.user.email || '');
      setUserId(session.user.id);

      if (!session.user.email_confirmed_at) {
        setStep('verify_otp');
        return;
      }

      await evaluateUserProfile(session.user.id, session.user.email || '');
    };

    inspectSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!mounted) return;
      if (!session?.user) {
        setStep('auth');
        return;
      }
      setEmail(session.user.email || '');
      setUserId(session.user.id);
      if (!session.user.email_confirmed_at) {
        setStep('verify_otp');
      } else {
        await evaluateUserProfile(session.user.id, session.user.email || '');
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const evaluateUserProfile = async (uid: string, userEmail: string) => {
    const { data: existingProfile, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', uid)
      .maybeSingle();

    if (error) {
      setErrorMessage(error.message);
      setStep('auth');
      return;
    }

    if (!existingProfile) {
      await supabase
        .from('users')
        .insert({
          id: uid,
          email: userEmail,
          onboarding_completed: false,
        })
        .select('*')
        .single();

      setStep('onboarding');
      return;
    }

    if (
      !existingProfile.onboarding_completed ||
      !existingProfile.username ||
      !existingProfile.full_name ||
      !existingProfile.date_of_birth ||
      !existingProfile.avatar_url
    ) {
      setFullName(existingProfile.full_name || '');
      setDateOfBirth(existingProfile.date_of_birth || '');
      setUsername(existingProfile.username || '');
      setAvatarPreview(existingProfile.avatar_url || null);
      setStep('onboarding');
      return;
    }

    await supabase
      .from('users')
      .update({ is_online: true, last_seen: new Date().toISOString() })
      .eq('id', uid);

    onAuthenticated({ ...existingProfile, is_online: true });
    setStep('ready');
  };

  useEffect(() => {
    if (step !== 'onboarding') return;

    const normalized = username.trim().toLowerCase();
    if (!normalized) {
      setUsernameStatus('idle');
      return;
    }

    const validPattern = /^[a-z0-9_]{4,32}$/;
    if (!validPattern.test(normalized)) {
      setUsernameStatus('invalid');
      return;
    }

    setUsernameStatus('checking');
    const debounceTimer = setTimeout(async () => {
      const { data: rpcAvailable, error: rpcError } = await supabase.rpc(
        'check_username_available',
        {
          candidate_username: normalized,
          current_uid: userId,
        }
      );

      if (!rpcError && typeof rpcAvailable === 'boolean') {
        setUsernameStatus(rpcAvailable ? 'available' : 'taken');
        return;
      }

      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('username', normalized)
        .neq('id', userId || '')
        .maybeSingle();

      setUsernameStatus(existingUser ? 'taken' : 'available');
    }, 320);

    return () => clearTimeout(debounceTimer);
  }, [username, step, userId]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setSubmitting(true);

    try {
      const cleanEmail = email.trim().toLowerCase();
      if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
        });

        if (error) throw error;

        if (data.user) {
          setUserId(data.user.id);
        }

        if (data.session && data.user?.email_confirmed_at) {
          await evaluateUserProfile(data.user.id, cleanEmail);
        } else {
          setResendCooldown(60);
          setStatusMessage('تم إرسال رمز التحقق المكون من 6 أرقام إلى بريدك الإلكتروني عبر Resend.');
          setStep('verify_otp');
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });

        if (error) {
          if (error.message.toLowerCase().includes('email not confirmed')) {
            await supabase.auth.resend({
              type: 'signup',
              email: cleanEmail,
            });
            setResendCooldown(60);
            setStatusMessage('يرجى تأكيد بريدك الإلكتروني بإدخال الرمز المكون من 6 أرقام المرسل إليك.');
            setStep('verify_otp');
            return;
          }
          throw error;
        }

        if (data.user) {
          setUserId(data.user.id);
          if (!data.user.email_confirmed_at) {
            setStep('verify_otp');
          } else {
            await evaluateUserProfile(data.user.id, cleanEmail);
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'حدث خطأ أثناء المصادقة';
      setErrorMessage(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleOtpDigitChange = (index: number, value: string) => {
    const cleanDigit = value.replace(/[^0-9]/g, '').slice(-1);
    const updated = [...otpDigits];
    updated[index] = cleanDigit;
    setOtpDigits(updated);

    if (cleanDigit && index < 5) {
      otpInputRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpInputRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6);
    if (!pasted) return;
    const nextDigits = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i += 1) {
      nextDigits[i] = pasted[i];
    }
    setOtpDigits(nextDigits);
    const focusIdx = Math.min(pasted.length, 5);
    otpInputRefs.current[focusIdx]?.focus();
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = otpDigits.join('');
    if (token.length !== 6) {
      setErrorMessage('يرجى إدخال رمز التحقق الكامل المكون من 6 أرقام.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const cleanEmail = email.trim().toLowerCase();
      let verifyResult = await supabase.auth.verifyOtp({
        email: cleanEmail,
        token,
        type: 'signup',
      });

      if (verifyResult.error) {
        verifyResult = await supabase.auth.verifyOtp({
          email: cleanEmail,
          token,
          type: 'email',
        });
      }

      if (verifyResult.error) {
        throw verifyResult.error;
      }

      const verifiedUser = verifyResult.data.user;
      if (!verifiedUser) {
        throw new Error('تم التحقق بنجاح ولكن تعذر تحميل الجلسة.');
      }

      setUserId(verifiedUser.id);
      await evaluateUserProfile(verifiedUser.id, cleanEmail);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'رمز التحقق غير صحيح أو منتهي الصلاحية.';
      setErrorMessage(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResendOtp = async () => {
    if (resendCooldown > 0) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setSubmitting(true);

    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim().toLowerCase(),
      });
      if (error) throw error;
      setResendCooldown(60);
      setStatusMessage('تم إرسال رمز تحقق جديد مكون من 6 أرقام إلى بريدك الإلكتروني.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'تعذر إعادة إرسال رمز التحقق.';
      setErrorMessage(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAvatarSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setErrorMessage('يجب أن يكون حجم الصورة الشخصية أقل من 5 ميجابايت.');
      return;
    }
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleCompleteOnboarding = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const normalizedUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{4,32}$/.test(normalizedUsername)) {
      setErrorMessage(
        'اسم المستخدم يجب أن يتكون من 4 أحرف على الأقل ويحتوي على أحرف إنجليزية صغيرة وأرقام وشرطة سفلية فقط.'
      );
      return;
    }

    if (usernameStatus !== 'available') {
      setErrorMessage('يرجى اختيار اسم مستخدم متاح وغير مكرر.');
      return;
    }

    if (!fullName.trim()) {
      setErrorMessage('الاسم الكامل مطلوب.');
      return;
    }

    if (!dateOfBirth) {
      setErrorMessage('تاريخ الميلاد مطلوب.');
      return;
    }

    if (!avatarFile && !avatarPreview) {
      setErrorMessage('يرجى رفع صورة شخصية لإكمال إعداد الحساب.');
      return;
    }

    if (!userId) {
      setErrorMessage('انتهت الجلسة، يرجى تسجيل الدخول مجدداً.');
      return;
    }

    setSubmitting(true);

    try {
      let finalAvatarUrl = avatarPreview;

      if (avatarFile) {
        const ext = avatarFile.name.split('.').pop()?.toLowerCase() || 'jpg';
        const filePath = `${userId}/avatar-${Date.now()}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(filePath, avatarFile, {
            cacheControl: '3600',
            upsert: true,
          });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage
          .from('avatars')
          .getPublicUrl(filePath);

        finalAvatarUrl = publicUrlData.publicUrl;
      }

      const { data: updatedProfile, error: updateError } = await supabase
        .from('users')
        .upsert(
          {
            id: userId,
            email: email.trim().toLowerCase(),
            full_name: fullName.trim(),
            date_of_birth: dateOfBirth,
            username: normalizedUsername,
            avatar_url: finalAvatarUrl,
            onboarding_completed: true,
            is_online: true,
            last_seen: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        )
        .select('*')
        .single();

      if (updateError) throw updateError;

      onAuthenticated(updatedProfile as UserProfile);
      setStep('ready');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'تعذر حفظ بيانات الملف الشخصي.';
      setErrorMessage(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'loading') {
    return (
      <div dir="rtl" className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-200">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
          <p className="text-sm text-slate-400">جاري التحقق من الجلسة...</p>
        </div>
      </div>
    );
  }

  if (step === 'ready') {
    return <>{children}</>;
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8">
        {step === 'auth' && (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center font-bold text-lg">
                MS
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">
                  {authMode === 'signup' ? 'إنشاء حساب جديد' : 'تسجيل الدخول'}
                </h1>
                <p className="text-xs text-slate-400">
                  منصة تواصل اجتماعي ومراسلة فورية ومكالمات مباشرة
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 rounded-xl border border-slate-800 mb-6">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('signup');
                  setErrorMessage(null);
                }}
                className={`py-2 text-xs font-semibold rounded-lg transition ${
                  authMode === 'signup'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                حساب جديد
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('signin');
                  setErrorMessage(null);
                }}
                className={`py-2 text-xs font-semibold rounded-lg transition ${
                  authMode === 'signin'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                تسجيل الدخول
              </button>
            </div>

            {errorMessage && (
              <div className="mb-4 p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs">
                {errorMessage}
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  البريد الإلكتروني
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-500 absolute right-3.5 top-3" />
                  <input
                    type="email"
                    required
                    dir="ltr"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full pr-10 pl-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500 text-left"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  كلمة المرور
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute right-3.5 top-3" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    dir="ltr"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="8 أحرف على الأقل"
                    className="w-full pr-10 pl-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500 text-left"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl font-semibold text-sm text-white flex items-center justify-center gap-2 transition"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <span>
                      {authMode === 'signup' ? 'إرسال رمز التحقق (6 أرقام)' : 'دخول'}
                    </span>
                    <ArrowLeft className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          </div>
        )}

        {step === 'verify_otp' && (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">تأكيد البريد الإلكتروني</h2>
                <p className="text-xs text-slate-400">
                  أدخل الرمز المكون من 6 أرقام المرسل إلى{' '}
                  <span className="text-slate-200" dir="ltr">
                    {email}
                  </span>
                </p>
              </div>
            </div>

            {statusMessage && (
              <div className="mb-4 p-3 rounded-xl bg-emerald-950/50 border border-emerald-800 text-emerald-200 text-xs">
                {statusMessage}
              </div>
            )}

            {errorMessage && (
              <div className="mb-4 p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs">
                {errorMessage}
              </div>
            )}

            <form onSubmit={handleVerifyOtp} className="space-y-5">
              <div dir="ltr" className="flex items-center justify-between gap-2">
                {otpDigits.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={(el) => {
                      otpInputRefs.current[idx] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpDigitChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    onPaste={handleOtpPaste}
                    className="w-12 h-14 text-center text-lg font-bold bg-slate-950 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-indigo-500"
                  />
                ))}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl font-semibold text-sm text-white flex items-center justify-center gap-2 transition"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <span>تأكيد الرمز والمتابعة</span>
                )}
              </button>
            </form>

            <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
              <button
                type="button"
                onClick={handleResendOtp}
                disabled={resendCooldown > 0 || submitting}
                className="flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 disabled:text-slate-600"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>
                  {resendCooldown > 0
                    ? `إعادة الإرسال بعد ${resendCooldown} ثانية`
                    : 'إعادة إرسال الرمز'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setStep('auth')}
                className="hover:text-slate-200"
              >
                تغيير البريد الإلكتروني
              </button>
            </div>
          </div>
        )}

        {step === 'onboarding' && (
          <div>
            <div className="mb-6">
              <span className="inline-block px-2.5 py-1 rounded-md bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 text-xs font-semibold mb-2">
                إعداد الملف الشخصي الإلزامي
              </span>
              <h2 className="text-xl font-bold text-white">أكمل بيانات حسابك</h2>
              <p className="text-xs text-slate-400 mt-1">
                اختر اسم مستخدم فريداً (4 أحرف على الأقل) وارفع صورتك الشخصية لفتح التطبيق.
              </p>
            </div>

            {errorMessage && (
              <div className="mb-4 p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs">
                {errorMessage}
              </div>
            )}

            <form onSubmit={handleCompleteOnboarding} className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-slate-950 border border-slate-800 overflow-hidden flex items-center justify-center shrink-0">
                  {avatarPreview ? (
                    <img
                      src={avatarPreview}
                      alt="معاينة الصورة"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <User className="w-7 h-7 text-slate-600" />
                  )}
                </div>
                <label className="flex-1 cursor-pointer">
                  <div className="px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-indigo-500 transition flex items-center gap-2 text-xs font-medium text-slate-200">
                    <Upload className="w-4 h-4 text-indigo-400" />
                    <span>{avatarFile ? avatarFile.name : 'رفع الصورة الشخصية'}</span>
                  </div>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleAvatarSelection}
                    className="hidden"
                  />
                </label>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  الاسم الكامل
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-500 absolute right-3.5 top-3" />
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="أدخل اسمك الكامل"
                    className="w-full pr-10 pl-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  تاريخ الميلاد
                </label>
                <div className="relative">
                  <Calendar className="w-4 h-4 text-slate-500 absolute right-3.5 top-3" />
                  <input
                    type="date"
                    required
                    max={new Date().toISOString().split('T')[0]}
                    value={dateOfBirth}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                    className="w-full pr-10 pl-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  اسم المستخدم الفريد (4 أحرف على الأقل، أحرف صغيرة وأرقام)
                </label>
                <div className="relative">
                  <AtSign className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    required
                    minLength={4}
                    maxLength={32}
                    dir="ltr"
                    value={username}
                    onChange={(e) =>
                      setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))
                    }
                    placeholder="username_handle"
                    className="w-full pl-10 pr-10 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500 text-left"
                  />
                  <div className="absolute right-3.5 top-3">
                    {usernameStatus === 'checking' && (
                      <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                    )}
                    {usernameStatus === 'available' && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    )}
                    {(usernameStatus === 'taken' || usernameStatus === 'invalid') && (
                      <XCircle className="w-4 h-4 text-rose-400" />
                    )}
                  </div>
                </div>
                <div className="mt-1.5 text-xs">
                  {usernameStatus === 'available' && (
                    <span className="text-emerald-400">
                      المعرف @{username} متاح للاستخدام.
                    </span>
                  )}
                  {usernameStatus === 'taken' && (
                    <span className="text-rose-400">
                      المعرف @{username} محجوز مسبقاً.
                    </span>
                  )}
                  {usernameStatus === 'invalid' && (
                    <span className="text-amber-400">
                      يجب ألا يقل عن 4 خانات (أحرف إنجليزية صغيرة، أرقام، أو شرطة سفلية).
                    </span>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting || usernameStatus !== 'available'}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl font-semibold text-sm text-white flex items-center justify-center gap-2 transition"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <span>حفظ البيانات والدخول للتطبيق</span>
                )}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};