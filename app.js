const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');
const dotenv = require('dotenv');
dotenv.config();
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const multer = require('multer')
const router = express.Router();

const app = express();
const port = process.env.PORT || 3000;

const upload = multer({ dest: "uploads/" });

const DRIVE_CLIENT_ID = process.env.DRIVE_CLIENT_ID;
const DRIVE_CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET;
const DRIVE_REDIRECT_URI = "https://developers.google.com/oauthplayground";
const DRIVE_REFRESH_TOKEN = process.env.DRIVE_REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(
    DRIVE_CLIENT_ID,
    DRIVE_CLIENT_SECRET,
    DRIVE_REDIRECT_URI
);

oauth2Client.setCredentials({ refresh_token: DRIVE_REFRESH_TOKEN });
const drive = google.drive({ version: "v3", auth: oauth2Client });

const TRANSPORTER = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.MAIL_ID,
        pass: process.env.PASSWORD
    }
});

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/', router);

// Function to read JSON file
function readJsonFile(filePath) {
    try {
        const jsonData = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(jsonData);
    } catch (error) {
        console.error('Error reading JSON file:', error);
        return null;
    }
}

// Function to read CSV file
function readCsvFile(filePath) {
    const results = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
}

// Function to extract file IDs from Google Drive links
function extractFileIds(attachment_path) {
    if (!attachment_path) return [];
  
    const links = attachment_path.split(",");
  
    return links
      .map((link) => {
        // Extract file ID from various forms of Google Drive links
        const patterns = [
          /\/file\/d\/([^\/]+)/, // matches /file/d/{fileId}
          /id=([^&]+)/, // matches id={fileId}
          /\/([^\/]+)\/view/, // matches /{fileId}/view
        ];
  
        for (let pattern of patterns) {
          const match = link.match(pattern);
          if (match && match[1]) {
            return match[1];
          }
        }
  
        console.warn(`Could not extract file ID from link: ${link}`);
        return null;
      })
      .filter((id) => id !== null);
}

// Set view engine
app.set('view engine', 'ejs');

router.get('/dashboard', async (req, res) => {
    // Get all pending emails
    const emails = readJsonFile('emails.json') || [];
    // const pendingEmails = emails.filter((email) => email.status === 'pending');
    res.render('dashboard', { pendingEmails });
});

router.get('/', async (req, res) => {
    res.render('outbox');
});

router.get('/compose', async (req, res) => {
    res.render('compose');
});

router.post('/compose', upload.array("files"), async (req, res) => {

    // Handle file uploads
    const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10 MB in bytes

    // Calculate total size of uploaded files
    let totalSize = 0;
    req.files.forEach((file) => {
        totalSize += file.size;
    });

    // Check if total size exceeds 5MB
    if (totalSize > MAX_TOTAL_SIZE) {
        return res
            .status(400)
            .send(
                `Total file size exceeds 10MB. Your files total: ${(
                    totalSize /
                    (1024 * 1024)
                ).toFixed(2)}MB`
            );
    }

    const attachment_path = [];
    if (req.files && req.files.length > 0) {
        for (const file of req.files) {
            const response = await drive.files.create({
                requestBody: {
                    name: file.originalname,
                    mimeType: file.mimetype,
                    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
                },
                media: {
                    mimeType: file.mimetype,
                    body: fs.createReadStream(file.path),
                },
            });

            // Make the file publicly accessible
            await drive.permissions.create({
                fileId: response.data.id,
                requestBody: {
                    role: "reader",
                    type: "anyone",
                },
            });

            const result = await drive.files.get({
                fileId: response.data.id,
                fields: "webViewLink, webContentLink",
            });

            attachment_path.push(result.data.webViewLink);

            // Delete the temporary file
            fs.unlinkSync(file.path);
        }
    }

    const mailData = {
        alias: req.body.alias,
        senderName: req.body.senderName,
        senderEmail: req.body.senderEmail,
        subject: req.body.subject,
        mailBody: req.body.mailBody,
        status: 'pending',
        attachments: attachment_path,
        timestamp: new Date().toISOString()
    };

    try {
        let emails = readJsonFile('emails.json') || [];
        emails.push(mailData);
        fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
        res.status(200).json({ message: 'Email data saved successfully' });
    } catch (error) {
        console.error('Error saving email data:', error);
        res.status(500).json({ error: 'Failed to save email data' });
    }
});


router.post("/mail-approved", async (req, res) => {

    // According to alias read csv file and get all emails
    const emails = await readCsvFile(`./${req.body.alias}.csv`);

    const attachmentIds = extractFileIds(req.body.attachment_path);
    const attachments = await Promise.all(
      attachmentIds.map(async (fileId, index) => {
        try {
          // Get file metadata
          const fileMetadata = await drive.files.get({
            fileId: fileId,
            fields: "name, mimeType",
          });

          // Get file content
          const response = await drive.files.get(
            { fileId: fileId, alt: "media" },
            { responseType: "stream" }
          );

          // Convert stream to buffer
          const buffers = [];
          for await (const chunk of response.data) {
            buffers.push(chunk);
          }
          const fileBuffer = Buffer.concat(buffers);

          return {
            filename: fileMetadata.data.name,
            content: fileBuffer,
            contentType: fileMetadata.data.mimeType,
          };
        } catch (error) {
          console.error(`Error fetching attachment ${fileId}:`, error.message);
          return null;
        }
      })
    );

    // Filter out any null attachments (failed downloads)
    const validAttachments = attachments.filter(
      (attachment) => attachment !== null
    );

    const mailOptions = {
        from: `<${process.env.MAIL_ID}>`,
        to: emails.map((email) => email.email).join(", "),
        cc: req.body.senderEmail,
        subject: req.body.subject,
        html: req.body.mailBody,
        attachments: validAttachments,
    };

    try {
        await new Promise((resolve, reject) => {
            // Send the email
            TRANSPORTER.sendMail(mailOptions, async (error, info) => {
                if (error) {
                    console.error("Error occurred:", error.message);
                    reject(error);
                } else {
                    // Mark the email as sent
                    let emails = readJsonFile('emails.json') || [];
                    emails = emails.map((email) => {
                        if (email.timestamp === req.body.timestamp) {
                            email.status = 'sent';
                        }
                        return email;
                    });
                    fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
                    console.log("Email sent successfully!", info.messageId);
                    resolve(info);
                }
            });
        });

        // Delete files from Google Drive
        for (const fileId of attachmentIds) {
            try {
                await drive.files.delete({ fileId: fileId });
                console.log(`File ${fileId} deleted successfully.`);
            } catch (error) {
                console.error(`Error deleting file ${fileId}:`, error.message);
            }
        }

        res.sendStatus(202);
    } catch (error) {
        console.error("Error:", error.message);
        res.sendStatus(400);
    }
});

router.post('/mail-rejected', async (req, res) => {
    const attachmentIds = extractFileIds(req.body.attachment_path);

    // Mark the email as rejected
    let emails = readJsonFile('emails.json') || [];
    emails = emails.map((email) => {
        if (email.timestamp === req.body.timestamp) {
            email.status = 'rejected';
        }
        return email;
    });
    fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
    
    // Delete files from Google Drive
    for (const fileId of attachmentIds) {
        try {
          await drive.files.delete({ fileId: fileId });
          console.log(`File ${fileId} deleted successfully.`);
        } catch (error) {
          console.error(`Error deleting file ${fileId}:`, error.message);
        }
    }
    
    res.sendStatus(202);
});

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});