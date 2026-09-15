# ---------------------------------------------------------------------------
# Dedicated OneSIM staging VPC — 10.20.0.0/16 (fully separate from esimiot).
# ---------------------------------------------------------------------------

resource "aws_vpc" "staging" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, { Name = "onesim-staging-vpc" })
}

resource "aws_internet_gateway" "staging" {
  vpc_id = aws_vpc.staging.id
  tags   = merge(local.common_tags, { Name = "onesim-staging-igw" })
}

# --- Subnets (2 AZs: af-south-1a, af-south-1b) ---

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.staging.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true
  tags = merge(local.common_tags, {
    Name = "onesim-staging-public-${count.index + 1}-${var.azs[count.index]}"
  })
}

resource "aws_subnet" "private_app" {
  count                   = 2
  vpc_id                  = aws_vpc.staging.id
  cidr_block              = var.private_app_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false
  tags = merge(local.common_tags, {
    Name = "onesim-staging-private-app-${count.index + 1}-${var.azs[count.index]}"
  })
}

resource "aws_subnet" "database" {
  count                   = 2
  vpc_id                  = aws_vpc.staging.id
  cidr_block              = var.database_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false
  tags = merge(local.common_tags, {
    Name = "onesim-staging-db-${count.index + 1}-${var.azs[count.index]}"
  })
}

# --- NAT (single, staging-only) ---

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = merge(local.common_tags, { Name = "onesim-staging-nat-eip" })
}

resource "aws_nat_gateway" "staging" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id # public subnet A only
  tags          = merge(local.common_tags, { Name = "onesim-staging-nat" })
}

# --- Route tables ---

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.staging.id
  tags   = merge(local.common_tags, { Name = "onesim-staging-public-rt" })
}

resource "aws_route" "public_igw" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.staging.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private_app" {
  vpc_id = aws_vpc.staging.id
  tags   = merge(local.common_tags, { Name = "onesim-staging-private-app-rt" })
}

resource "aws_route" "private_app_nat" {
  route_table_id         = aws_route_table.private_app.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.staging.id
}

resource "aws_route_table_association" "private_app" {
  count          = 2
  subnet_id      = aws_subnet.private_app[count.index].id
  route_table_id = aws_route_table.private_app.id
}

# Dedicated database route table WITHOUT a default route: database subnets have
# NO Internet/NAT path (only the VPC-local route).
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.staging.id
  tags   = merge(local.common_tags, { Name = "onesim-staging-db-rt" })
}

resource "aws_route_table_association" "database" {
  count          = 2
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}