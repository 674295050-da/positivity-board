# 📌 Positivity Board

เว็บแอปแปะโน้ตส่งกำลังใจแบบไม่เปิดเผยตัวตน สร้างด้วย Google Apps Script + Google Sheets

## ฟีเจอร์
- 🔐 เข้าสู่ระบบด้วย Google (OAuth 2.0) รองรับ Gmail ทั่วไป
- 👑 ระบบแอดมิน: ลบโน้ตที่ไม่เหมาะสมได้ (กำหนดผ่าน `ADMIN_EMAILS`)
- 💖 กดหัวใจได้คนละ 1 ครั้งต่อโน้ต
- 🤖 AI Chatbot "น้องฮีลใจ" (Gemini)
- 🔍 ค้นหา และกรองตามสีโน้ต

## โครงสร้าง
```
src/
├─ Code.gs          # Backend (Apps Script)
├─ Index.html       # Frontend
└─ appsscript.json  # Manifest
```

## วิธีติดตั้ง

### 1) เตรียม Google Sheet
สร้างชีตชื่อ `Sticky_Board_DB` แท็บ `Sheet1` หัวคอลัมน์แถวแรก:
`ID | ToWho | Message | BgColor | Emoji | Likes | CreatedAt | AuthorEmail`
(แท็บ `Likes` ระบบสร้างให้เอง)

### 2) วางโค้ด
Extensions → Apps Script แล้ววาง `Code.gs` และ `Index.html` (หรือใช้ `clasp push`)

### 3) Deploy ครั้งแรกเพื่อให้ได้ URL
Deploy → New deployment → Web app → **Execute as: Me** / **Who has access: Anyone**
คัดลอก Web app URL (ลงท้าย `/exec`)

### 4) สร้าง OAuth Client
1. [Google Cloud Console](https://console.cloud.google.com) → สร้างโปรเจกต์
2. APIs & Services → OAuth consent screen: เลือก External ใส่ชื่อแอปและอีเมล
   scope พื้นฐาน (openid, email, profile) แล้วเปลี่ยนสถานะเป็น **In production**
   (ไม่เช่นนั้นเฉพาะ test users เข้าได้)
3. Credentials → Create credentials → OAuth client ID → **Web application**
   ใส่ Authorized redirect URI = Web app URL จากข้อ 3 (ต้องตรงทุกตัวอักษร)
4. คัดลอก Client ID และ Client secret

### 5) ตั้ง Script Properties
Project Settings → Script Properties

| Property | ค่า |
|---|---|
| `GEMINI_API_KEY` | key จาก Google AI Studio |
| `OAUTH_CLIENT_ID` | จากข้อ 4 |
| `OAUTH_CLIENT_SECRET` | จากข้อ 4 |
| `ADMIN_EMAILS` | อีเมลแอดมิน คั่นด้วย `,` |
| `APP_URL` | Web app URL จากข้อ 3 |

จากนั้นรันฟังก์ชัน `setupSessionSecret` หนึ่งครั้งเพื่อสร้าง `SESSION_SECRET`

### 6) Deploy เวอร์ชันใหม่
Deploy → Manage deployments → ดินสอ → New version → Deploy
(ใช้ "Manage deployments" เสมอ เพื่อให้ URL เดิมไม่เปลี่ยน)

## ความเป็นส่วนตัว
โน้ตแสดงแบบนิรนามบนหน้าเว็บ แต่ระบบเก็บอีเมลผู้เขียนไว้ในคอลัมน์ `AuthorEmail`
เพื่อให้แอดมินตรวจสอบได้ ควรตั้งสิทธิ์ชีตให้เฉพาะเจ้าของ/แอดมินเท่านั้น

## ความปลอดภัย
- ห้าม commit API key, Client secret หรือ SESSION_SECRET ลง GitHub
- ค่าลับทั้งหมดอยู่ใน Script Properties เท่านั้น

## อัปขึ้น GitHub
```bash
git init
git add .
git commit -m "Initial commit: Positivity Board"
git branch -M main
git remote add origin https://github.com/<ชื่อผู้ใช้>/positivity-board.git
git push -u origin main
```

## ระบบแอดมิน
อีเมลที่อยู่ใน `ADMIN_EMAILS` จะเห็นป้าย ADMIN และปุ่ม **🛡️ แผงแอดมิน**

| ฟีเจอร์ | วิธีใช้ |
|---|---|
| ซ่อน/กู้คืนโน้ต | ปุ่ม 🙈 / ♻️ บนโน้ต (โน้ตที่ซ่อนยังอยู่ในชีต คอลัมน์ `Status` = `hidden` และเห็นเฉพาะแอดมิน) |
| รายงานโน้ต | ผู้ใช้ทั่วไปกด 🚩 (คนละ 1 ครั้งต่อโน้ต) ข้อมูลอยู่แท็บ `Reports` |
| ตรวจรายงาน | แผงแอดมิน → ซ่อนโน้ต / ปัดทิ้ง / แบนผู้เขียน |
| แบน/ปลดแบน | ผู้ถูกแบนโพสต์ กดหัวใจ รายงาน และคุยกับ AI ไม่ได้ ข้อมูลอยู่แท็บ `Bans` |

แท็บ `Likes`, `Reports`, `Bans` และคอลัมน์ `Status` ระบบสร้างให้อัตโนมัติ
โน้ตเก่าที่ไม่มี `AuthorEmail` จะแบนผู้เขียนไม่ได้
