const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const dotenv = require('dotenv');
const { google } = require('googleapis');
dotenv.config();

async function searchEmailById(messageId) {
    try {
        
        const imapConfig = {
            user: process.env.MAIL_ID,
            password: process.env.MAIL_PASSWORD,
            host: process.env.IMAP_HOST,
            port: 993, // IMAP Port for Gmail
            tls: true,
            tlsOptions: { rejectUnauthorized: false }
        };

        const imap = new Imap(imapConfig);

        imap.once('ready', () => {
            imap.openBox('[Gmail]/Sent Mail', false, (err, box) => {
                if (err) {
                    console.error('Error opening inbox:', err);
                    return;
                }

                // Format message ID if needed
                const formattedMessageId = messageId.startsWith('<') ? messageId : `<${messageId}>`;
                console.log('Searching for message ID:', formattedMessageId);

                imap.search([['HEADER', 'MESSAGE-ID', formattedMessageId]], (err, results) => {
                    if (err) {
                        console.error('Search error:', err);
                        imap.end();
                        return;
                    }

                    if (!results.length) {
                        console.log('No email found with this Message-ID');
                        imap.end();
                        return;
                    }

                    console.log(`Found ${results.length} matching email(s)`);

                    const fetch = imap.fetch(results, { bodies: '' });

                    fetch.on('message', (msg) => {
                        msg.on('body', (stream) => {
                            simpleParser(stream, (err, parsed) => {
                                if (err) {
                                    console.error('Parsing error:', err);
                                    return;
                                }
                                
                                console.log('Email Details:');
                                console.log('From:', parsed.from?.text);
                                console.log('Subject:', parsed.subject);
                                console.log('Date:', parsed.date);
                                console.log('Body:', parsed.text);
                                console.log('HTML Body:', parsed.html);
                                
                                if (parsed.attachments?.length > 0) {
                                    console.log('\nAttachments:');
                                    parsed.attachments.forEach(attachment => {
                                        console.log(`- ${attachment.filename} (${attachment.contentType})`);
                                    });
                                }
                            });
                        });
                    });

                    fetch.once('error', (err) => {
                        console.error('Fetch error:', err);
                    });

                    fetch.once('end', () => {
                        console.log('Done fetching email');
                        imap.end();
                    });
                });
            });
        });

        imap.once('error', (err) => {
            console.error('IMAP connection error:', err);
        });

        imap.once('end', () => {
            console.log('IMAP connection ended');
        });

        imap.connect();

    } catch (error) {
        console.error('Error in searchEmailById:', error);
    }
}

// Usage example - replace with your message ID
// const messageId = "<CADGt0T1nJ0Z-J+mp5xm57LewGnfV8CBRUan5mDr9yNUwCWhj0w@mail.gmail.com>";
const messageId = "<fbd1914d-dc61-3548-4a8c-16db0d831006@ashoka.edu.in>";
if (!messageId) {
    console.error('Please provide a message ID as a command line argument');
    process.exit(1);
}
console.log('Message-ID provided:', messageId);
searchEmailById(messageId);