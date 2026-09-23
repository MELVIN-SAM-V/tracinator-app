output "zone_id" {
  value = aws_route53_zone.root.zone_id
}

output "name_servers" {
  description = "Add these as NS records at the external registrar to delegate the domain to Route53."
  value       = aws_route53_zone.root.name_servers
}
