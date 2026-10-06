# Email (FR-12.3) through Amazon SES's API, signed by the task role: no SMTP password exists.
# The domain is verified with DKIM records in the same hosted zone. A new SES account is in the
# sandbox and only delivers to verified addresses until production access is granted.

resource "aws_ses_domain_identity" "this" {
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "this" {
  domain = aws_ses_domain_identity.this.domain
}

# SES always issues three DKIM tokens.
resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "${aws_ses_domain_dkim.this.dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_ses_domain_dkim.this.dkim_tokens[count.index]}.dkim.amazonses.com"]
}
