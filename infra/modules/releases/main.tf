# Static hosting for the desktop app's update manifest (latest.json) and
# installer files — what tauri-plugin-updater's check() fetches (see
# src-tauri/tauri.conf.json's plugins.updater.endpoints and
# infra/scripts/publish_release.sh, which is what actually uploads here).
#
# Deliberately much simpler than ../frontend: no SPA routing (there's no
# app here, just files), no API origin, and no WAF. Traffic here is one
# small check() request per app launch plus occasional installer/manifest
# downloads — nowhere near the abuse surface ../frontend's WAF exists for
# (a public, unauthenticated demo API). Add a WAF later if that stops
# being true; not a gap to silently paper over, just not needed yet.

resource "aws_s3_bucket" "releases" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "releases" {
  bucket                  = aws_s3_bucket.releases.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "releases" {
  name                              = "${var.bucket_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "bucket_policy" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.releases.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "releases" {
  bucket = aws_s3_bucket.releases.id
  policy = data.aws_iam_policy_document.bucket_policy.json
}

resource "aws_cloudfront_distribution" "this" {
  enabled = true
  aliases = [var.domain_name]

  origin {
    domain_name              = aws_s3_bucket.releases.bucket_regional_domain_name
    origin_id                = "s3-releases"
    origin_access_control_id = aws_cloudfront_origin_access_control.releases.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-releases"
    viewer_protocol_policy = "redirect-to-https"
    # AWS managed: CachingOptimized. latest.json changes on every release —
    # publish_release.sh invalidates /latest.json on each publish rather
    # than relying on a short TTL, so this can stay the same
    # bandwidth-friendly policy the installers themselves benefit from.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "alias" {
  zone_id = var.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
