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
const MAILING_LIST_FILE = 'mailingList.json';

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

const imapConfig = {
    user: process.env.MAIL_ID,
    password: process.env.MAIL_PASSWORD,
    host: process.env.IMAP_HOST,
    port: 993, // IMAP Port for Gmail
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 10000, // Increase timeout to 10 seconds
    authTimeout: 10000  // Increase auth timeout
};

const TRANSPORTER = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.MAIL_ID,
        pass: process.env.MAIL_PASSWORD
    }
});

const imap = new Imap(imapConfig);

imap.connect();


imap.once('error', (err) => {
    console.error('IMAP Error:', err);
    if (err.source === 'timeout') {
        console.log('Reconnecting in 10 seconds...');
        setTimeout(() => imap.connect(), 10000); // Retry connection
    }
});

imap.once('end', () => {
    console.log('IMAP Connection closed. Reconnecting...');
    setTimeout(() => imap.connect(), 5000); // Reconnect after 5 seconds
});

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


function checkEmails() {
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 24);

    imap.search([
        'UNSEEN',
        ["FROM", process.env.APPROVER_EMAIL]
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
                            html.toLowerCase().includes('[approved]')) {
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
                                hasApprovalText: html.toLowerCase().includes('[approved]'),
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

function readConfirmedMailingList() {
    try {
        const data = fs.readFileSync('mailingList.json');
        return JSON.parse(data).filter(entry => entry.status === 'confirmed').map(entry => entry.email);
    } catch (error) {
        console.error('Error reading mailing list:', error);
        return [];
    }
}

function forwardEmail(parsedEmail) {
    const recipientEmails = readConfirmedMailingList();
    const BATCH_SIZE = 100; // Gmail max per email
    const DAILY_LIMIT = 500; // Max recipients per day
    const DELAY_MS = 3000; // 3 seconds between batches to avoid spam filters
    const DAY_MS = 24 * 60 * 60 * 1000; // 24 hours

    if (recipientEmails.length === 0) {
        console.log('No confirmed recipients to send emails to.');
        return;
    }

    let totalSent = 0;

    function sendBatch(startIndex) {
        if (startIndex >= recipientEmails.length) {
            console.log('All emails sent successfully!');
            return;
        }

        if (totalSent >= DAILY_LIMIT) {
            console.log(`Daily limit reached (${DAILY_LIMIT} emails). Pausing for 24 hours...`);
            setTimeout(() => sendBatch(startIndex), DAY_MS);
            return;
        }

        const batch = recipientEmails.slice(startIndex, startIndex + BATCH_SIZE);
        totalSent += batch.length;

        const mailOptions = {
            from: `${process.env.FORWARD_EMAIL_ALIAS} <${process.env.MAIL_ID}>`,
            bcc: batch.join(','), // Use BCC for privacy
            subject: `${parsedEmail.subject}`,
            html: parsedEmail.html,
            attachments: parsedEmail.attachments
        };

        TRANSPORTER.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error(`Error sending batch ${startIndex / BATCH_SIZE + 1}:`, error);
                return;
            }
            console.log(`Batch ${startIndex / BATCH_SIZE + 1} sent successfully:`, info.messageId);

            setTimeout(() => sendBatch(startIndex + BATCH_SIZE), DELAY_MS);
        });
    }

    console.log(`Starting email sending process...`);
    sendBatch(0);
}


// function forwardEmail(parsedEmail) {
//     const recipientEmails = process.env.RECIPIENT_EMAILS;

//     const mailOptions = {
//         from: `Organisation Mail <${process.env.MAIL_ID}>`,
//         to: recipientEmails, // Forward to custom recipients
//         subject: `${parsedEmail.subject}`,
//         // text: parsedEmail.text,
//         html: parsedEmail.html,
//         attachments: parsedEmail.attachments
//     };

//     TRANSPORTER.sendMail(mailOptions, (error, info) => {
//         if (error) {
//             console.error('Forwarding error:', error);
//             return;
//         }
//         console.log('Original email forwarded successfully:', info.messageId);
//     });
// }

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/', router);
app.use(express.static('public'));
// Set view engine
app.set('view engine', 'ejs');


router.get('/', async (req, res) => {
    res.redirect('/compose');
});


router.get('/subscribe', async (req, res) => {
    res.render('subscribe');
});

// Generate a 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// Read the mailing list file
const readMailingList = () => {
    if (!fs.existsSync(MAILING_LIST_FILE)) return [];
    return JSON.parse(fs.readFileSync(MAILING_LIST_FILE, 'utf8'));
};

// Write to the mailing list file
const writeMailingList = (data) => {
    fs.writeFileSync(MAILING_LIST_FILE, JSON.stringify(data, null, 4));
};

// Send OTP email
const sendOTPEmail = async (email, otp) => {
    const mailOptions = {
        from: process.env.MAIL_ID,
        to: email,
        subject: 'Your OTP Code',
        text: `Your OTP code is: ${otp}. It is valid for 10 minutes.`
    };

    try {
        await TRANSPORTER.sendMail(mailOptions);
        console.log(`OTP sent to ${email}`);
        return true;
    } catch (error) {
        console.error('Error sending OTP:', error);
        return false;
    }
};


router.post('/subscribe-get-otp', async (req, res) => {
    const { email } = req.body;
    console.log(req.body);
    let mailingList = readMailingList();
    let existingEntry = mailingList.find(entry => entry.email === email);
    const otp = generateOTP();
    if (existingEntry) {
        existingEntry.otp = otp;
        existingEntry.status = 'pending';
    } else {
        mailingList.push({ email, status: 'pending', otp });
    }
    writeMailingList(mailingList);
    success = await sendOTPEmail(email, otp);
console.log(success);
if (success) {
    res.status(202).json({ message: 'OTP sent successfully' });
} else {
    res.status(400).json({ error: 'Failed to send OTP' });
}

});

router.post('/subscribe-validate-otp', async (req, res) => {
    const { email, otp, action } = req.body;
    let mailingList = readMailingList();
    let existingEntry = mailingList.find(entry => entry.email === email);

    if (!existingEntry) {
        return res.status(404).json({ error: 'Email not found' });
    }
    if (existingEntry.otp !== otp) {
        return res.status(401).json({ error: 'Invalid OTP' });
    }
    if (parseInt(action) === 1) {
        existingEntry.status = 'confirmed';
        existingEntry.otp = ""; // Clear OTP after successful validation
        writeMailingList(mailingList);
        return res.status(202).json({ message: 'Email confirmed successfully!' });
    }

    if (parseInt(action) === -1) {
        mailingList = mailingList.filter(entry => entry.email !== email);
        writeMailingList(mailingList);
        return res.status(202).json({ message: 'Email removed successfully!' });
    }

    return res.status(400).json({ error: 'Invalid action' });
});


router.get('/compose', async (req, res) => {
    res.render('compose');
});


router.post('/compose', upload.array("files"), async (req, res) => {
    const approverEmail = process.env.APPROVER_EMAIL;

    const mailOptions = {
        from: `Mail Approval <${process.env.MAIL_ID}>`,
        to: approverEmail,
        cc: req.body.email,
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


// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});