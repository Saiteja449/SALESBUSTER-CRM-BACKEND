import nodemailer from "nodemailer";

export const sendEmail = async (options) => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_PORT == 465,
      family: 4, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const mailOptions = {
      from: process.env.SMTP_FROM || `Kranthi Elevators CRM <${process.env.SMTP_USER || "noreply@kranthielevators.com"}>`,
      to: options.email,
      subject: options.subject,
      text: options.message,
      html: options.htmlMessage,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${options.email}`);
    return true
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
  }
};
