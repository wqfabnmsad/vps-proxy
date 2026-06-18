# SMS Proxy (Taqnyat) — VPS + Coolify

خدمة Proxy خفيفة (Node 20 + Hono) تعمل على VPS الخاص بك لإعادة توجيه طلبات SMS
إلى `api.taqnyat.sa` من **IP ثابت** مُسجَّل في القائمة البيضاء لدى تقنيات.

> هذا المجلد مستقل تماماً عن تطبيق Lovable ولا يُبنى معه. يُنشر يدوياً عبر Coolify.

## النشر على Coolify

1. **ارفع المجلد إلى Git** (مستودع خاص، GitHub/GitLab/Gitea):
   - يمكن أن يكون نفس المستودع، فقط وجّه Coolify إلى المجلد الفرعي `vps-proxy/` عبر **Base Directory**.

2. **في Coolify:**
   - **+ New Resource → Application**
   - اختر المستودع، الفرع، و **Base Directory** = `vps-proxy`
   - **Build Pack:** `Dockerfile`
   - **Port (Exposes):** `3000`

3. **Environment Variables:**
   ```
   PROXY_SECRET=<ولّد سراً قوياً: openssl rand -hex 32>
   PORT=3000
   ALLOWED_HOSTS=api.taqnyat.sa
   ```

4. **Domain:** اربط نطاقاً فرعياً مثل `sms-proxy.yourdomain.com`
   - Coolify يُصدر شهادة Let's Encrypt تلقائياً.

5. **Health Check Path:** `/health`

6. **Deploy** → انتظر حتى تصبح الحالة **Running**.

7. اختبر:
   ```bash
   curl https://sms-proxy.yourdomain.com/health
   # → {"ok":true,"service":"sms-proxy","time":"..."}
   ```

8. **سجّل IP الـ VPS** (وليس IP Coolify الداخلي) في لوحة تقنيات → القائمة البيضاء.
   - تعرف على IP العام: `curl -s ifconfig.me` من داخل الـ VPS.

## ربط Lovable

أضف هذين السرّين في إعدادات الأسرار بتطبيق Lovable:

| الاسم | القيمة |
|---|---|
| `SMS_PROXY_URL` | `https://sms-proxy.yourdomain.com` |
| `SMS_PROXY_SECRET` | نفس قيمة `PROXY_SECRET` على VPS |

بمجرد توفّر السرّين، يبدأ `src/lib/sms.functions.ts` تلقائياً بتوجيه الطلبات عبر الـ Proxy.
لتعطيل الـ Proxy مؤقتاً: احذف أحد السرّين، فيعود الإرسال المباشر.

## التشغيل محلياً للاختبار

```bash
cd vps-proxy
npm install
PROXY_SECRET=test-secret-please-change PORT=3000 node server.js
```

## استكشاف الأعطال

- **401 unauthorized:** قيمة `X-Proxy-Secret` لا تطابق `PROXY_SECRET`.
- **5xx من تقنيات:** الـ Proxy يُعيد نفس الاستجابة. تحقق من Coolify Logs.
- **ما زالت تظهر أخطاء IP:** تأكد أن IP الذي سجّلته في تقنيات هو IP العام للـ VPS، وأن Coolify لا يستخدم بروكسي خارجي خلفه.
