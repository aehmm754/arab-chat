# تواصل مباشر (arab-chat)

تطبيق مراسلة + مجتمع + مكالمات (Next.js + Supabase + Capacitor للأندرويد).

## خطوات التشغيل (مرة وحدة)

### 1) Supabase
1. افتح **SQL Editor** والصق محتوى `supabase/schema.sql` كامل ثم **Run**.
2. من **Project Settings > API** انسخ **Project URL** (شكله `https://xxxx.supabase.co`).
3. رابط Supabase والمفتاح العام موجودين أصلاً في `.env.production` (جاهز، لا تحتاج تعدل شي).
4. رمز التحقق (OTP): اتبع الخطوة 3 في ملف الدليل (Resend SMTP + قالب `{{ .Token }}` في Confirm signup).

### 2) GitHub
```bash
git init && git add . && git commit -m "init"
git branch -M main
git remote add origin https://github.com/USERNAME/arab-chat.git
git push -u origin main
```
بعد الرفع: تبويب **Actions** > **Build Android (APK + AAB)** (يشتغل تلقائياً).
بعد ~5-10 دقايق حمّل من **Artifacts**: `arab-chat-apk` و `arab-chat-aab`.

### 3) توقيع ثابت (مهم قبل Google Play)
بدون إعداد، الـ APK يتوقع بمفتاح مؤقت (يتثبت عادي على سامسونج لكن ما ينفع للتحديث أو Play Store).
للمفتاح الدائم:
```bash
keytool -genkeypair -v -keystore release.keystore -alias arabchat -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.keystore   # انسخ الناتج
```
أضف في GitHub > Settings > Secrets > Actions: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
**احتفظ بنسخة من release.keystore ولا ترفعه على GitHub.**

## تشغيل محلي
```bash
npm install
npm run dev
```

## ملاحظات
- المكالمات تستخدم STUN فقط؛ على بعض شبكات الجوال قد تفشل. للإنتاج أضف خادم TURN في `RTC_CONFIG`.
- لا تضع **Secret key** من Supabase داخل التطبيق أبداً.
