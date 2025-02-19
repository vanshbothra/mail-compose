const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');
const dotenv = require('dotenv');
dotenv.config();
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const multer = require('multer')
const router = express.Router();
const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

const imapConfig = {
    user: process.env.MAIL_ID,
    password: process.env.MAIL_PASSWORD,
    host: process.env.IMAP_HOST,
    port: 993, // IMAP Port for Gmail
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
};

const TRANSPORTER = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.MAIL_ID,
        pass: process.env.MAIL_PASSWORD
    }
});

const imap = new Imap(imapConfig);

function openInbox(cb) {
    imap.openBox('INBOX', false, cb);
}

imap.once('ready', function () {
    openInbox((err, box) => {
        if (err) throw err;
        console.log(`Listening for new emails in ${box.name}...`);

        // Listen for new mail
        imap.on('mail', function () {
            console.log('New email detected...');
            checkEmails();
        });
    });
});

// function checkEmails() {
//     const oneHourAgo = new Date();
//     oneHourAgo.setHours(oneHourAgo.getHours() - 24);

//     imap.search([
//         'UNSEEN',
//         ['SINCE', oneHourAgo]
//     ], (err, results) => {
//         if (err || !results.length) return;

//         const fetch = imap.fetch(results, { bodies: ['HEADER.FIELDS (SUBJECT FROM REFERENCES IN-REPLY-TO MESSAGE-ID)', 'TEXT'], markSeen: true });

//         fetch.on('message', (msg) => {
//             let emailBody = '';
//             let subject = '';
//             let fromEmail = '';
//             let references = '';
//             let inReplyTo = '';
//             let messageId = '';
//             let html_data = '';
//             let mailtoIndex = -1;

//             msg.on('body', (stream, info) => {
//                 let buffer = '';
//                 simpleParser(stream, (err, parsed) => {
//                     if (err) {
//                         console.error('Parsing error:', err);
//                         return;
//                     }
//                     console.log('Email Details:');
//                     console.log('Text:', parsed.text);
//                     console.log('HTML Body:', parsed.textAsHtml);
//                     html_data = parsed.textAsHtml;
//                     if (html_data) {
//                         mailtoIndex = html_data.indexOf(`mailto:${process.env.MAIL_ID}`);
//                     }
//                     if (mailtoIndex !== -1) {
//                         html_data = html_data.substring(0, mailtoIndex + `mailto:${process.env.MAIL_ID}`.length);
//                     }
//                 });
//                 stream.on('data', (chunk) => {
//                     buffer += chunk.toString('utf8');
//                 });

//                 stream.on('end', () => {
//                     if (info.which === 'HEADER.FIELDS (SUBJECT FROM REFERENCES IN-REPLY-TO MESSAGE-ID)') {
//                         const header = Imap.parseHeader(buffer);
//                         subject = header.subject?.[0] || '';
//                         fromEmail = header.from?.[0] || '';
//                         references = header.references?.[0] || '';
//                         inReplyTo = header['in-reply-to']?.[0] || '';
//                         messageId = header['message-id']?.[0] || ''; // Capture Message-ID
//                     } else {
//                         emailBody = buffer.toLowerCase();
//                         // console.log("Email Body", emailBody);
//                     }
//                 });
//             });

//             msg.once('end', () => {
//                 console.log('HTML Data:', html_data);
//                 if (html_data.includes('approved')) {
//                     console.log('Approval detected in reply. Finding original email...');
//                     console.log('Subject:', subject, 'InReplyTo:', inReplyTo, 'References:', references, 'Message-ID:', messageId);

//                     // Start backtracking from this message ID
//                     const firstMessageId = inReplyTo || (references ? references.split(' ').pop() : null);
//                     if (!firstMessageId) {
//                         console.error('No thread reference found, skipping...');
//                         return;
//                     }
//                     searchSentEmailById(firstMessageId);
//                 } else {
//                     console.log('No approval detected in reply. Skipping...');
//                 }
//             });
//         });

//         fetch.once('error', (err) => console.error('Fetch error:', err));
//     });
// }

function checkEmails() {
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 24);

    imap.search([
        'UNSEEN',
        ['SINCE', oneHourAgo]
    ], (err, results) => {
        if (err || !results.length) return;

        const fetch = imap.fetch(results, { 
            bodies: ['HEADER.FIELDS (SUBJECT FROM REFERENCES IN-REPLY-TO MESSAGE-ID)', 'TEXT'], 
            markSeen: true 
        });

        fetch.on('message', (msg) => {
            let inReplyTo = '';
            let messageId = '';
            let fromEmail = '';

            msg.on('body', (stream, info) => {
                if (info.which === 'HEADER.FIELDS (SUBJECT FROM REFERENCES IN-REPLY-TO MESSAGE-ID)') {
                    let buffer = '';
                    stream.on('data', (chunk) => {
                        buffer += chunk.toString('utf8');
                    });
                    stream.on('end', () => {
                        const header = Imap.parseHeader(buffer);
                        inReplyTo = header['in-reply-to']?.[0] || '';
                        messageId = header['message-id']?.[0] || '';
                        // Extract sender's email from the 'from' header
                        fromEmail = header.from?.[0] || '';
                        // Clean up email address (remove name and angle brackets)
                        fromEmail = fromEmail.match(/<(.+)>/)?.[1] || fromEmail;
                    });
                } else {
                    // Parse email body
                    simpleParser(stream, (err, parsed) => {
                        if (err) {
                            console.error('Parsing error:', err);
                            return;
                        }

                        let html = parsed.textAsHtml || '';
                        const mailtoIndex = html.indexOf(`mailto:${process.env.MAIL_ID}`);
                        
                        if (mailtoIndex !== -1) {
                            // Trim everything after mailto
                            html = html.substring(0, mailtoIndex);
                        }

                        // Check if the sender is the approver and the message contains 'approved'
                        if (fromEmail.toLowerCase() === process.env.APPROVER_EMAIL.toLowerCase() && 
                            html.toLowerCase().includes('approved')) {
                            console.log('Approval detected from authorized approver.');
                            if (inReplyTo) {
                                console.log('Original message ID:', inReplyTo);
                                searchSentEmailById(inReplyTo);
                            } else {
                                console.error('No in-reply-to header found');
                            }
                        } else {
                            console.log('No valid approval detected:', {
                                isApprover: fromEmail.toLowerCase() === process.env.APPROVER_EMAIL.toLowerCase(),
                                hasApprovalText: html.toLowerCase().includes('approved'),
                                fromEmail: fromEmail
                            });
                        }
                    });
                }
            });
        });

        fetch.once('error', (err) => console.error('Fetch error:', err));
    });
}

async function searchSentEmailById(messageId) {
    try {
        const imapSentConfig = {
            user: process.env.MAIL_ID,
            password: process.env.MAIL_PASSWORD,
            host: process.env.IMAP_HOST,
            port: 993,
            tls: true,
            tlsOptions: { rejectUnauthorized: false }
        };

        const imap_sent = new Imap(imapSentConfig);

        imap_sent.once('ready', () => {
            imap_sent.openBox('[Gmail]/Sent Mail', false, (err, box) => {
                if (err) {
                    console.error('Error opening inbox:', err);
                    return;
                }

                const formattedMessageId = messageId.startsWith('<') ? messageId : `<${messageId}>`;
                console.log('Searching for message ID:', formattedMessageId);

                imap_sent.search([['HEADER', 'MESSAGE-ID', formattedMessageId]], (err, results) => {
                    if (err || !results.length) {
                        console.error('Search error or no results:', err);
                        imap_sent.end();
                        return;
                    }

                    console.log(`Found ${results.length} matching email(s)`);
                    const fetch = imap_sent.fetch(results, { bodies: '' });

                    fetch.on('message', (msg) => {
                        msg.on('body', (stream) => {
                            // Use simpleParser to parse the email and forward it
                            simpleParser(stream, (err, parsed) => {
                                if (err) {
                                    console.error('Parsing error:', err);
                                    return;
                                }
                                // Forward the parsed email
                                forwardEmail(parsed);
                            });
                        });
                    });

                    fetch.once('error', (err) => console.error('Fetch error:', err));
                    fetch.once('end', () => {
                        console.log('Done fetching email');
                        imap_sent.end();
                    });
                });
            });
        });

        imap_sent.once('error', (err) => console.error('IMAP connection error:', err));
        imap_sent.once('end', () => console.log('IMAP connection ended'));
        imap_sent.connect();

    } catch (error) {
        console.error('Error in searchEmailById:', error);
    }
}

function forwardEmail(parsedEmail) {
    const recipientEmails = [
        'ibrahim.khalil_ug25@ashoka.edu.in',
    ];

    const mailOptions = {
        from: `Organisation Mail <${process.env.MAIL_ID}>`,
        to: recipientEmails.join(','), // Forward to custom recipients
        subject: `${parsedEmail.subject}`,
        // text: parsedEmail.text,
        html: parsedEmail.html,
        attachments: parsedEmail.attachments
    };

    TRANSPORTER.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Forwarding error:', error);
            return;
        }
        console.log('Original email forwarded successfully:', info.messageId);
    });
}

imap.once('error', (err) => console.error('IMAP Error:', err));
imap.once('end', () => {
    console.log('IMAP Connection closed. Reconnecting...');
    setTimeout(() => imap.connect(), 5000); // Reconnect after 5 seconds
});

imap.connect();

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/', router);
app.use(express.static('public'));
// Set view engine
app.set('view engine', 'ejs');

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

router.get('/dashboard', async (req, res) => {
    // Get all pending emails
    // const emails = readJsonFile('emails.json') || [];
    // const pendingEmails = emails.filter((email) => email.status === 'pending');
    // res.render('dashboard', { pendingEmails });
    res.render('dashboard');
});

router.get('/', async (req, res) => {
    res.render('outbox');
});

router.get('/compose', async (req, res) => {
    res.render('compose');
});


router.post('/compose', upload.array("files"), async (req, res) => {
    const approverEmail = 'vansh.bothra_ug25@ashoka.edu.in';

    const mailOptions = {
        from: `Mail Approval <${process.env.MAIL_ID}>`,
        to: approverEmail,
        subject: req.body.subject,
        html: req.body.mailBody,
        attachments: req.files ? req.files.map(file => ({
            filename: file.originalname,
            path: file.path
        })) : []
    };

    console.log('Request Body:', req.body);

    try {
        await TRANSPORTER.sendMail(mailOptions);
        
        // Clean up temporary files after sending
        if (req.files) {
            req.files.forEach(file => fs.unlinkSync(file.path));
        }
        res.json({
            status: 200,
            message: 'Email sent for approval',
        });
    } catch (error) {
        console.error('Error sending email:', error);
        // Clean up files if email fails
        if (req.files) {
            req.files.forEach(file => fs.unlinkSync(file.path));
        }
        res.json({
            status: 500,
            error: 'Failed to send email',
            details: error.message
        });
    }
});

// router.post('/compose', upload.array("files"), async (req, res) => {

//     // Handle file uploads
//     const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10 MB in bytes

//     // Calculate total size of uploaded files
//     let totalSize = 0;
//     req.files.forEach((file) => {
//         totalSize += file.size;
//     });

//     // Check if total size exceeds 5MB
//     if (totalSize > MAX_TOTAL_SIZE) {
//         return res
//             .status(400)
//             .send(
//                 `Total file size exceeds 10MB. Your files total: ${(
//                     totalSize /
//                     (1024 * 1024)
//                 ).toFixed(2)}MB`
//             );
//     }

//     const attachment_path = [];
//     if (req.files && req.files.length > 0) {
//         for (const file of req.files) {
//             const response = await drive.files.create({
//                 requestBody: {
//                     name: file.originalname,
//                     mimeType: file.mimetype,
//                     parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
//                 },
//                 media: {
//                     mimeType: file.mimetype,
//                     body: fs.createReadStream(file.path),
//                 },
//             });

//             // Make the file publicly accessible
//             await drive.permissions.create({
//                 fileId: response.data.id,
//                 requestBody: {
//                     role: "reader",
//                     type: "anyone",
//                 },
//             });

//             const result = await drive.files.get({
//                 fileId: response.data.id,
//                 fields: "webViewLink, webContentLink",
//             });

//             attachment_path.push(result.data.webViewLink);

//             // Delete the temporary file
//             fs.unlinkSync(file.path);
//         }
//     }

//     const mailData = {
//         alias: req.body.alias,
//         senderName: req.body.senderName,
//         senderEmail: req.body.senderEmail,
//         subject: req.body.subject,
//         mailBody: req.body.mailBody,
//         status: 'pending',
//         attachments: attachment_path,
//         timestamp: new Date().toISOString()
//     };

//     try {
//         let emails = readJsonFile('emails.json') || [];
//         emails.push(mailData);
//         fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
//         res.status(200).json({ message: 'Email data saved successfully' });
//     } catch (error) {
//         console.error('Error saving email data:', error);
//         res.status(500).json({ error: 'Failed to save email data' });
//     }
// });


// router.post("/mail-approved", async (req, res) => {

//     // According to alias read csv file and get all emails
//     const emails = await readCsvFile(`./${req.body.alias}.csv`);

//     const attachmentIds = extractFileIds(req.body.attachment_path);
//     const attachments = await Promise.all(
//       attachmentIds.map(async (fileId, index) => {
//         try {
//           // Get file metadata
//           const fileMetadata = await drive.files.get({
//             fileId: fileId,
//             fields: "name, mimeType",
//           });

//           // Get file content
//           const response = await drive.files.get(
//             { fileId: fileId, alt: "media" },
//             { responseType: "stream" }
//           );

//           // Convert stream to buffer
//           const buffers = [];
//           for await (const chunk of response.data) {
//             buffers.push(chunk);
//           }
//           const fileBuffer = Buffer.concat(buffers);

//           return {
//             filename: fileMetadata.data.name,
//             content: fileBuffer,
//             contentType: fileMetadata.data.mimeType,
//           };
//         } catch (error) {
//           console.error(`Error fetching attachment ${fileId}:`, error.message);
//           return null;
//         }
//       })
//     );

//     // Filter out any null attachments (failed downloads)
//     const validAttachments = attachments.filter(
//       (attachment) => attachment !== null
//     );

//     const mailOptions = {
//         from: `<${process.env.MAIL_ID}>`,
//         to: emails.map((email) => email.email).join(", "),
//         cc: req.body.senderEmail,
//         subject: req.body.subject,
//         html: req.body.mailBody,
//         attachments: validAttachments,
//     };

//     try {
//         await new Promise((resolve, reject) => {
//             // Send the email
//             TRANSPORTER.sendMail(mailOptions, async (error, info) => {
//                 if (error) {
//                     console.error("Error occurred:", error.message);
//                     reject(error);
//                 } else {
//                     // Mark the email as sent
//                     let emails = readJsonFile('emails.json') || [];
//                     emails = emails.map((email) => {
//                         if (email.timestamp === req.body.timestamp) {
//                             email.status = 'sent';
//                         }
//                         return email;
//                     });
//                     fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
//                     console.log("Email sent successfully!", info.messageId);
//                     resolve(info);
//                 }
//             });
//         });

//         // Delete files from Google Drive
//         for (const fileId of attachmentIds) {
//             try {
//                 await drive.files.delete({ fileId: fileId });
//                 console.log(`File ${fileId} deleted successfully.`);
//             } catch (error) {
//                 console.error(`Error deleting file ${fileId}:`, error.message);
//             }
//         }

//         res.sendStatus(202);
//     } catch (error) {
//         console.error("Error:", error.message);
//         res.sendStatus(400);
//     }
// });

// router.post('/mail-rejected', async (req, res) => {
//     const attachmentIds = extractFileIds(req.body.attachment_path);

//     // Mark the email as rejected
//     let emails = readJsonFile('emails.json') || [];
//     emails = emails.map((email) => {
//         if (email.timestamp === req.body.timestamp) {
//             email.status = 'rejected';
//         }
//         return email;
//     });
//     fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
    
//     // Delete files from Google Drive
//     for (const fileId of attachmentIds) {
//         try {
//           await drive.files.delete({ fileId: fileId });
//           console.log(`File ${fileId} deleted successfully.`);
//         } catch (error) {
//           console.error(`Error deleting file ${fileId}:`, error.message);
//         }
//     }
    
//     res.sendStatus(202);
// });

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});