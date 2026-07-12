const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

async function sendSecurityAlert(email, subject, message, details = null) {
  try {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0B0D0C; color: #E8EDE9; border: 1px solid #262B27; border-radius: 8px;">
        <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #262B27;">
          <h1 style="color: #7FFFB0; font-size: 24px; margin: 0;">🔐 seize Security Alert</h1>
          <p style="color: #8A928C; font-size: 14px;">${new Date().toLocaleString()}</p>
        </div>
        <div style="padding: 20px 0;">
          <h2 style="color: #FFB86B; font-size: 18px; margin-top: 0;">${subject}</h2>
          <p style="color: #E8EDE9; font-size: 16px; line-height: 1.6;">${message}</p>
          ${details ? `<pre style="background: #141715; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; color: #8A928C; border: 1px solid #262B27;">${JSON.stringify(details, null, 2)}</pre>` : ''}
        </div>
        <div style="padding-top: 20px; border-top: 1px solid #262B27; text-align: center; color: #565D59; font-size: 12px;">
          <p>This is an automated security alert from your seize server.</p>
          <p>If you didn't initiate this action, please check your server immediately.</p>
        </div>
      </div>
    `;

    const info = await transporter.sendMail({
      from: `"seize Security" <${process.env.SMTP_USER}>`,
      to: email || process.env.ALERT_EMAIL,
      subject: `🔐 seize Security Alert: ${subject}`,
      text: `${subject}\n\n${message}\n\n${details ? JSON.stringify(details, null, 2) : ''}\n\nThis is an automated security alert from your seize server.`,
      html: html,
    });

    console.log(`📧 Security email sent: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to send security email:', error.message);
    return false;
  }
}

async function sendLoginAlert(email, username, ip, userAgent) {
  const subject = 'New Login Detected';
  const message = `A new login was detected for user "${username}" from IP address ${ip}.`;
  const details = {
    username,
    ip,
    userAgent,
    timestamp: new Date().toISOString(),
  };
  return sendSecurityAlert(email, subject, message, details);
}

async function sendPasswordChangeAlert(email, username, ip) {
  const subject = 'Password Changed';
  const message = `The password for user "${username}" was changed from IP ${ip}.`;
  const details = {
    username,
    ip,
    timestamp: new Date().toISOString(),
  };
  return sendSecurityAlert(email, subject, message, details);
}

async function sendSuspiciousActivityAlert(email, username, ip, action, details) {
  const subject = '⚠️ Suspicious Activity Detected';
  const message = `Suspicious activity detected for user "${username}" from IP ${ip}. Action: ${action}`;
  return sendSecurityAlert(email, subject, message, { ...details, username, ip, action });
}

module.exports = {
  sendSecurityAlert,
  sendLoginAlert,
  sendPasswordChangeAlert,
  sendSuspiciousActivityAlert,
};
