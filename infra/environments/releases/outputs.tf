output "releases_url" {
  value = "https://releases.${var.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "Needed for cache invalidation after each publish_release.sh run."
  value       = module.releases.distribution_id
}

output "releases_bucket" {
  value = module.releases.bucket_name
}
