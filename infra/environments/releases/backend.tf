# Local state: fine for a sole developer running apply from one machine —
# same reasoning and same caveat as the demo environment's backend.tf.
# terraform.tfstate is gitignored (infra/**/*.tfstate).
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
