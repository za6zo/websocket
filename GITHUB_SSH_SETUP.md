# GitHub SSH Setup for Za6Zo

## SSH Key Generated

A new SSH key has been created for the Za6Zo GitHub account.

### Key Details
- **Email**: za6zoride@gmail.com
- **Key Type**: ED25519 (more secure than RSA)
- **Private Key**: `~/.ssh/github_za6zo`
- **Public Key**: `~/.ssh/github_za6zo.pub`

### Public Key (Add this to GitHub)

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKsje9NGfZCxpo3h4MClECXYIkTiVU/u5okTL0e5swi/ za6zoride@gmail.com
```

## Steps to Add SSH Key to GitHub

### 1. Copy the Public Key
The public key above is already copied. You can also get it with:
```bash
cat ~/.ssh/github_za6zo.pub
```

### 2. Add to GitHub Account
1. Go to https://github.com/settings/keys
2. Click **"New SSH key"**
3. Title: `Za6Zo Websocket Server`
4. Key type: **Authentication Key**
5. Paste the public key above into the "Key" field
6. Click **"Add SSH key"**

### 3. Test the Connection
After adding the key to GitHub, test it:
```bash
ssh -T git@github-za6zo
```

You should see:
```
Hi za6zo! You've successfully authenticated, but GitHub does not provide shell access.
```

## SSH Config

An SSH config has been added to `~/.ssh/config`:

```
# Za6Zo GitHub Account
Host github-za6zo
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_za6zo
    IdentitiesOnly yes
```

## Using the SSH Key

### Clone a Repository
```bash
git clone git@github-za6zo:za6zo/websocket.git
```

### Update Existing Repository Remote
```bash
cd /path/to/repo
git remote set-url origin git@github-za6zo:za6zo/websocket.git
```

### Push to GitHub
```bash
git push -u origin main
```

## Current Repository Configuration

The websocket repository is already configured to use this SSH key:
```
Remote URL: git@github-za6zo:za6zo/websocket.git
```

## Next Steps

1. **Add the public key to GitHub** (see steps above)
2. **Create the repository on GitHub**:
   - Go to https://github.com/za6zo
   - Click "New repository"
   - Name: `websocket`
   - **Do NOT initialize** with README
   - Create repository
3. **Push your code**:
   ```bash
   cd D:\Za6Zo\websocket
   git push -u origin main
   ```

## Troubleshooting

### Permission Denied (publickey)
If you get this error, the key isn't added to GitHub yet. Follow steps above.

### Host Key Verification Failed
Run:
```bash
ssh-keyscan github.com >> ~/.ssh/known_hosts
```

### Using Multiple GitHub Accounts
The SSH config allows you to use multiple GitHub accounts:
- Your personal account: `git@github.com:username/repo.git`
- Za6Zo account: `git@github-za6zo:za6zo/repo.git`

## Security Notes

- ✅ Private key is stored locally: `~/.ssh/github_za6zo`
- ✅ **NEVER** share your private key
- ✅ Only share the public key (the one above)
- ✅ The private key stays on your computer
- ✅ If compromised, delete the key from GitHub and generate a new one

## Quick Reference

```bash
# View public key
cat ~/.ssh/github_za6zo.pub

# Test GitHub connection
ssh -T git@github-za6zo

# Push to GitHub
cd D:\Za6Zo\websocket
git push -u origin main
```
